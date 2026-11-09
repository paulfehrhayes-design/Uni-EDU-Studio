# Reference: # https://github.com/bytedance/Make-An-Audio-2
from typing import Literal

import numpy as np
import torch
import torch.nn as nn


def _mel_filterbank(sr, n_fft, n_mels, fmin, fmax):
    """
    Create a mel filterbank matrix (replaces librosa.filters.mel).
    This avoids the librosa -> numba dependency chain.
    """
    # Mel conversion functions
    def hz_to_mel(f):
        return 2595.0 * np.log10(1.0 + f / 700.0)

    def mel_to_hz(m):
        return 700.0 * (10.0 ** (m / 2595.0) - 1.0)

    # Create mel points
    min_mel = hz_to_mel(fmin)
    max_mel = hz_to_mel(fmax)
    mels = np.linspace(min_mel, max_mel, n_mels + 2)
    freqs = mel_to_hz(mels)

    # FFT bin frequencies
    fft_freqs = np.fft.rfftfreq(n_fft, 1.0 / sr)

    # Build filterbank
    weights = np.zeros((n_mels, len(fft_freqs)), dtype=np.float32)
    for i in range(n_mels):
        lower = freqs[i]
        center = freqs[i + 1]
        upper = freqs[i + 2]

        # Rising slope
        if center > lower:
            weights[i] += np.where(
                (fft_freqs >= lower) & (fft_freqs <= center),
                (fft_freqs - lower) / (center - lower),
                0.0
            )
        # Falling slope
        if upper > center:
            weights[i] += np.where(
                (fft_freqs >= center) & (fft_freqs <= upper),
                (upper - fft_freqs) / (upper - center),
                0.0
            )

    return weights


def dynamic_range_compression_torch(x, C=1, clip_val=1e-5, *, norm_fn):
    return norm_fn(torch.clamp(x, min=clip_val) * C)


def spectral_normalize_torch(magnitudes, norm_fn):
    output = dynamic_range_compression_torch(magnitudes, norm_fn=norm_fn)
    return output


class MelConverter(nn.Module):

    def __init__(
        self,
        *,
        sampling_rate: float,
        n_fft: int,
        num_mels: int,
        hop_size: int,
        win_size: int,
        fmin: float,
        fmax: float,
        norm_fn,
    ):
        super().__init__()
        self.sampling_rate = sampling_rate
        self.n_fft = n_fft
        self.num_mels = num_mels
        self.hop_size = hop_size
        self.win_size = win_size
        self.fmin = fmin
        self.fmax = fmax
        self.norm_fn = norm_fn

        mel = _mel_filterbank(sr=self.sampling_rate,
                              n_fft=self.n_fft,
                              n_mels=self.num_mels,
                              fmin=self.fmin,
                              fmax=self.fmax)
        mel_basis = torch.from_numpy(mel).float()
        hann_window = torch.hann_window(self.win_size)

        self.register_buffer('mel_basis', mel_basis)
        self.register_buffer('hann_window', hann_window)

    @property
    def device(self):
        return self.mel_basis.device

    def forward(self, waveform: torch.Tensor, center: bool = False) -> torch.Tensor:
        waveform = waveform.clamp(min=-1., max=1.).to(self.device)

        waveform = torch.nn.functional.pad(
            waveform.unsqueeze(1),
            [int((self.n_fft - self.hop_size) / 2),
             int((self.n_fft - self.hop_size) / 2)],
            mode='reflect')
        waveform = waveform.squeeze(1)

        spec = torch.stft(waveform,
                          self.n_fft,
                          hop_length=self.hop_size,
                          win_length=self.win_size,
                          window=self.hann_window,
                          center=center,
                          pad_mode='reflect',
                          normalized=False,
                          onesided=True,
                          return_complex=True)

        spec = torch.view_as_real(spec)
        spec = torch.sqrt(spec.pow(2).sum(-1) + (1e-9))
        spec = torch.matmul(self.mel_basis, spec)
        spec = spectral_normalize_torch(spec, self.norm_fn)

        return spec


def get_mel_converter(mode: Literal['16k', '44k']) -> MelConverter:
    if mode == '16k':
        return MelConverter(sampling_rate=16_000,
                            n_fft=1024,
                            num_mels=80,
                            hop_size=256,
                            win_size=1024,
                            fmin=0,
                            fmax=8_000,
                            norm_fn=torch.log10)
    elif mode == '44k':
        return MelConverter(sampling_rate=44_100,
                            n_fft=2048,
                            num_mels=128,
                            hop_size=512,
                            win_size=2048,
                            fmin=0,
                            fmax=44100 / 2,
                            norm_fn=torch.log)
    else:
        raise ValueError(f'Unknown mode: {mode}')
