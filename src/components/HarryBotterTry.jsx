import { useCallback, useEffect, useRef, useState } from 'react';

const SESSION_STORAGE_KEY = 'edu-classroom-session';
const MAX_CHAT_MESSAGES = 12;
const MAX_KNOWLEDGE_BYTES = 100_000;
const MAX_G1_SPEECH_PREVIEW_CHARS = 120;
const EMPTY_AGENT_DRAFT = {
  agent_id: null,
  display_name: '',
  purpose: '',
  instructions: '',
  generation_temperature: 0.4,
  generation_max_tokens: 500,
  is_builtin: false,
};
const LEARNING_LEVELS = [
  'Early Years',
  'PYP 1',
  'PYP 2',
  'PYP 3',
  'PYP 4',
  'PYP 5',
  'MYP 1',
  'MYP 2',
  'MYP 3',
  'MYP 4',
  'MYP 5',
  'DP 1',
  'DP 2',
];

function getMicrophoneAccessErrorMessage(error) {
  if (error?.name === 'NotAllowedError' || error?.name === 'SecurityError') {
    return 'Microphone access was denied or blocked. If this preview is embedded, open it in a full browser tab using the link above. Then allow microphone access in the browser and check your operating system microphone privacy setting.';
  }
  if (error?.name === 'NotFoundError') {
    return 'No microphone was found. Connect a microphone or choose an available input device, then try again.';
  }
  if (error?.name === 'NotReadableError') {
    return 'The microphone is busy or unavailable. Close other apps using it and try again.';
  }
  if (error?.name === 'OverconstrainedError') {
    return 'The selected microphone is unavailable. Choose the system default or another input device.';
  }
  return error?.message || 'The browser reported an unknown microphone error.';
}

export default function HarryBotterTry() {
  const [credentials, setCredentials] = useState({ username: '', password: '' });
  const [loginError, setLoginError] = useState('');
  const [isLoggingIn, setIsLoggingIn] = useState(false);
  const [teacherSession, setTeacherSession] = useState(null);
  const [learningLevel, setLearningLevel] = useState('');
  const [tone, setTone] = useState('Formal');
  const [speechSpeed, setSpeechSpeed] = useState(1);
  const [previewMode, setPreviewMode] = useState('text');
  const [agents, setAgents] = useState([]);
  const [knowledgeDocuments, setKnowledgeDocuments] = useState([]);
  const [selectedAgentId, setSelectedAgentId] = useState('general');
  const [agentDraft, setAgentDraft] = useState(null);
  const [isLoadingConfig, setIsLoadingConfig] = useState(false);
  const [isSavingAgent, setIsSavingAgent] = useState(false);
  const [configError, setConfigError] = useState('');
  const [editingKnowledgeId, setEditingKnowledgeId] = useState(null);
  const [knowledgeDraft, setKnowledgeDraft] = useState({
    filename: '',
    title: '',
    source: '',
    owner: '',
    learning_level: '',
    agent_id: '',
    review_date: '',
    text: '',
    permission_confirmed: false,
  });
  const [isUploadingKnowledge, setIsUploadingKnowledge] = useState(false);
  const [isReadingKnowledge, setIsReadingKnowledge] = useState(false);
  const [knowledgeError, setKnowledgeError] = useState('');
  const [knowledgeStatus, setKnowledgeStatus] = useState('');
  const [modelStatus, setModelStatus] = useState(null);
  const [isCheckingModel, setIsCheckingModel] = useState(false);
  const [speechStatus, setSpeechStatus] = useState(null);
  const [g1RobotStatus, setG1RobotStatus] = useState(null);
  const [draftOutput, setDraftOutput] = useState('browser');
  const [g1SpeakerId, setG1SpeakerId] = useState('0');
  const [isSendingG1Speech, setIsSendingG1Speech] = useState(false);
  const [g1SpeechStatus, setG1SpeechStatus] = useState('');
  const [g1SpeechError, setG1SpeechError] = useState('');
  const [chatText, setChatText] = useState('');
  const [chatMessages, setChatMessages] = useState([]);
  const [editingDraftIndex, setEditingDraftIndex] = useState(null);
  const [editedDraftText, setEditedDraftText] = useState('');
  const [isGeneratingDraft, setIsGeneratingDraft] = useState(false);
  const [chatError, setChatError] = useState('');
  const [microphones, setMicrophones] = useState([]);
  const [speakers, setSpeakers] = useState([]);
  const [microphoneId, setMicrophoneId] = useState('');
  const [speakerId, setSpeakerId] = useState('');
  const [voiceStatus, setVoiceStatus] = useState('Voice conversation has not been started.');
  const [voiceError, setVoiceError] = useState('');
  const [isVoiceSessionActive, setIsVoiceSessionActive] = useState(false);
  const [isStartingVoiceSession, setIsStartingVoiceSession] = useState(false);
  const [audioStatus, setAudioStatus] = useState('No microphone test has been recorded.');
  const [audioError, setAudioError] = useState('');
  const [showMicrophonePermissionHelp, setShowMicrophonePermissionHelp] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [recordingUrl, setRecordingUrl] = useState('');
  const [recordingBlob, setRecordingBlob] = useState(null);
  const [isTranscribingRecording, setIsTranscribingRecording] = useState(false);
  const [isPreparingSpeechIndex, setIsPreparingSpeechIndex] = useState(null);
  const [playingSpeechIndex, setPlayingSpeechIndex] = useState(null);
  const [speechError, setSpeechError] = useState('');
  const recorderRef = useRef(null);
  const speechRequestRef = useRef(null);
  const speechAudioRef = useRef(null);
  const streamRef = useRef(null);
  const audioChunksRef = useRef([]);
  const audioElementRef = useRef(null);
  const recordingUrlRef = useRef('');
  const recordingTimerRef = useRef(null);
  const draftRequestRef = useRef(null);
  const speechUrlsRef = useRef(new Set());
  const voiceSessionRef = useRef(null);
  const voiceStartupCancelledRef = useRef(false);
  const voiceTranscriptQueueRef = useRef([]);
  const voiceTranscriptProcessingRef = useRef(false);
  const chatMessagesRef = useRef(chatMessages);
  const isGeneratingDraftRef = useRef(isGeneratingDraft);
  const g1AudioConnected = g1RobotStatus?.capabilities?.audio === true;
  chatMessagesRef.current = chatMessages;
  isGeneratingDraftRef.current = isGeneratingDraft;

  const stopVoiceTracks = (session) => {
    if (session.tracksStopped) return;
    session.tracksStopped = true;
    session.stream?.getTracks().forEach((track) => track.stop());
  };
  const closeVoiceContext = (session) => {
    if (session.contextClosing || session.context?.state === 'closed') return;
    session.contextClosing = true;
    void session.context?.close();
  };
  const finishVoiceSession = (session, statusMessage) => {
    if (voiceSessionRef.current !== session) return;
    window.clearTimeout(session.stopTimer);
    window.clearTimeout(session.readyTimer);
    if (session.worklet) session.worklet.port.onmessage = null;
    session.source?.disconnect();
    session.worklet?.disconnect();
    stopVoiceTracks(session);
    closeVoiceContext(session);
    if (session.socket?.readyState < WebSocket.CLOSING) session.socket.close();
    voiceSessionRef.current = null;
    setIsVoiceSessionActive(false);
    setVoiceStatus(statusMessage);
  };

  const stopVoiceSession = (statusMessage = 'Voice conversation stopped.') => {
    const session = voiceSessionRef.current;
    if (!session || session.stopping) return;
    session.stopping = true;
    setIsVoiceSessionActive(false);
    setVoiceStatus('Stopping the microphone and finishing the current utterance…');
    if (session.worklet) session.worklet.port.onmessage = null;
    session.source?.disconnect();
    session.worklet?.disconnect();
    stopVoiceTracks(session);
    closeVoiceContext(session);
    if (session.socket?.readyState === WebSocket.OPEN) {
      session.socket.send(JSON.stringify({ type: 'stop' }));
      session.stopTimer = window.setTimeout(
        () => finishVoiceSession(session, statusMessage),
        15_000,
      );
    } else {
      finishVoiceSession(session, statusMessage);
    }
  };

  useEffect(() => {
    document.documentElement.classList.add('harry-botter-preview');
    document.body.classList.add('harry-botter-preview');
    return () => {
      document.documentElement.classList.remove('harry-botter-preview');
      document.body.classList.remove('harry-botter-preview');
    };
  }, []);

  useEffect(() => () => {
    draftRequestRef.current?.abort();
    speechRequestRef.current?.controller.abort();
    speechAudioRef.current?.pause();
    const voiceSession = voiceSessionRef.current;
    if (voiceSession) {
      window.clearTimeout(voiceSession.stopTimer);
      window.clearTimeout(voiceSession.readyTimer);
      voiceSession.socket.onclose = null;
      voiceSession.socket.onmessage = null;
      voiceSession.socket?.close();
      voiceSession.stream?.getTracks().forEach((track) => track.stop());
      if (voiceSession.context?.state !== 'closed') void voiceSession.context?.close();
      voiceSessionRef.current = null;
    }
    if (recordingTimerRef.current !== null) {
      window.clearTimeout(recordingTimerRef.current);
    }
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== 'inactive') {
      recorder.onstop = null;
      recorder.stop();
    }
    streamRef.current?.getTracks().forEach((track) => track.stop());
    if (recordingUrlRef.current) URL.revokeObjectURL(recordingUrlRef.current);
    speechUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
  }, []);

  useEffect(() => {
    const activeUrls = new Set(
      chatMessages.map((message) => message.speechUrl).filter(Boolean),
    );
    speechUrlsRef.current.forEach((url) => {
      if (!activeUrls.has(url)) {
        URL.revokeObjectURL(url);
        speechUrlsRef.current.delete(url);
      }
    });
  }, [chatMessages]);

  const refreshAudioDevices = async () => {
    if (!navigator.mediaDevices?.enumerateDevices) {
      throw new Error('This browser does not support audio device selection.');
    }
    const devices = await navigator.mediaDevices.enumerateDevices();
    setMicrophones(devices.filter((device) => device.kind === 'audioinput'));
    setSpeakers(devices.filter((device) => device.kind === 'audiooutput'));
  };

  const handleLogin = async (event) => {
    event.preventDefault();
    setLoginError('');
    setIsLoggingIn(true);
    try {
      const response = await fetch('/api/classroom/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(credentials),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.detail || 'Teacher sign-in failed.');
      if (result.user?.role !== 'teacher') {
        throw new Error('Use a teacher account to open the Harry Botter preview.');
      }

      const session = { token: result.token, user: result.user };
      localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
      setTeacherSession(session);
    } catch (error) {
      setLoginError(error.message || 'Teacher sign-in failed.');
    } finally {
      setIsLoggingIn(false);
    }
  };

  const checkLocalModel = useCallback(async (session = teacherSession) => {
    if (!session?.token) return;
    setIsCheckingModel(true);
    try {
      const response = await fetch('/api/harry-botter/model-status', {
        headers: { Authorization: `Bearer ${session.token}` },
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.detail || 'Could not check the local model.');
      setModelStatus(result);
    } catch (error) {
      setModelStatus({ status: 'service_unavailable', error: error.message });
    } finally {
      setIsCheckingModel(false);
    }
  }, [teacherSession]);

  const checkLocalSpeech = useCallback(async (session = teacherSession) => {
    if (!session?.token) return;
    try {
      const response = await fetch('/api/harry-botter/speech-status', {
        headers: { Authorization: `Bearer ${session.token}` },
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.detail || 'Could not check local speech models.');
      setSpeechStatus(result);
    } catch (error) {
      setSpeechStatus({ error: error.message || 'Could not check local speech models.' });
    }
  }, [teacherSession]);

  const checkG1AudioStatus = useCallback(async (session = teacherSession) => {
    if (!session?.token) return;
    try {
      const response = await fetch('/api/robot/status', {
        headers: { Authorization: `Bearer ${session.token}` },
        cache: 'no-store',
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.detail || 'Could not check the G1 audio connection.');
      setG1RobotStatus(result);
      if (result.capabilities?.audio !== true) setDraftOutput('browser');
    } catch (error) {
      setG1RobotStatus({ error: error.message || 'Could not check the G1 audio connection.' });
      setDraftOutput('browser');
    }
  }, [teacherSession]);

  const loadConfiguration = useCallback(async (session = teacherSession) => {
    if (!session?.token) return;
    setIsLoadingConfig(true);
    setConfigError('');
    try {
      const response = await fetch('/api/harry-botter/config', {
        headers: { Authorization: `Bearer ${session.token}` },
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.detail || 'Could not load agent settings.');
      if (!Array.isArray(result.agents) || result.agents.length === 0) {
        throw new Error('No Harry Botter agents are configured.');
      }
      setAgents(result.agents);
      setKnowledgeDocuments(Array.isArray(result.knowledge) ? result.knowledge : []);
      setSelectedAgentId((currentId) => (
        result.agents.some((agent) => agent.agent_id === currentId)
          ? currentId
          : result.agents[0].agent_id
      ));
      setAgentDraft((currentDraft) => (
        currentDraft || result.agents.find((agent) => agent.agent_id === 'general') || result.agents[0]
      ));
    } catch (error) {
      setConfigError(error.message || 'Could not load agent settings.');
    } finally {
      setIsLoadingConfig(false);
    }
  }, [teacherSession]);

  useEffect(() => {
    if (teacherSession) void checkLocalModel(teacherSession);
  }, [teacherSession, checkLocalModel]);

  useEffect(() => {
    if (teacherSession) void checkLocalSpeech(teacherSession);
  }, [teacherSession, checkLocalSpeech]);

  useEffect(() => {
    if (!teacherSession) return undefined;
    void checkG1AudioStatus(teacherSession);
    const timer = window.setInterval(() => {
      void checkG1AudioStatus(teacherSession);
    }, 5_000);
    return () => window.clearInterval(timer);
  }, [teacherSession, checkG1AudioStatus]);

  useEffect(() => {
    if (teacherSession) void loadConfiguration(teacherSession);
  }, [teacherSession, loadConfiguration]);

  const speakDraftOnG1 = async (text) => {
    if (isSendingG1Speech || draftOutput !== 'g1' || g1RobotStatus?.capabilities?.audio !== true) return;
    setG1SpeechError('');
    setG1SpeechStatus('');
    setIsSendingG1Speech(true);
    try {
      const response = await fetch('/api/harry-botter/g1-speak', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${teacherSession.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ text: text.trim(), speaker_id: Number(g1SpeakerId) }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.detail || 'The G1 did not accept the speech request.');
      setG1SpeechStatus('The G1 SDK accepted the TTS request. Check the robot speaker.');
    } catch (error) {
      setG1SpeechError(error.message || 'Could not send this draft to the G1 speaker.');
      void checkG1AudioStatus();
    } finally {
      setIsSendingG1Speech(false);
    }
  };

  const requestDraft = async (
    text,
    history,
    replaceMessageIndex = null,
    transcriptReceivedAt = null,
  ) => {
    if (!text.trim() || isGeneratingDraftRef.current) return;
    if (speechRequestRef.current) cancelSpeechGeneration();
    if (replaceMessageIndex === null) stopSpeechPlayback();
    setChatError('');
    isGeneratingDraftRef.current = true;
    setIsGeneratingDraft(true);
    const controller = new AbortController();
    draftRequestRef.current = controller;
    try {
      const response = await fetch('/api/harry-botter/draft', {
        method: 'POST',
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${teacherSession.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          text: text.trim(),
          learning_level: learningLevel,
          tone,
          agent_id: selectedAgentId,
          history: history.slice(-12).map(({ role, content }) => ({ role, content })),
        }),
      });
      const result = await response.json();
      if (controller.signal.aborted) return;
      if (!response.ok) throw new Error(result.detail || 'The local model could not create a draft.');
      if (!result.draft?.text) throw new Error('The local model returned an empty draft.');
      const newDraft = {
          role: 'assistant',
          content: result.draft.text,
          model: result.draft.model,
          source: result.draft.source,
          sources: result.draft.sources || [],
          transcriptToDraftMs: transcriptReceivedAt === null
            ? null
            : Math.round(performance.now() - transcriptReceivedAt),
      };
      if (replaceMessageIndex === null) {
        setChatMessages((messages) => {
          const nextMessages = [
            ...messages,
            { role: 'user', content: text.trim() },
            newDraft,
          ].slice(-MAX_CHAT_MESSAGES);
          chatMessagesRef.current = nextMessages;
          return nextMessages;
        });
        setChatText('');
      } else {
        if (playingSpeechIndex === replaceMessageIndex) stopSpeechPlayback();
        setChatMessages((messages) => messages.map((message, index) => (
          index === replaceMessageIndex ? newDraft : message
        )));
      }
      return true;
    } catch (error) {
      if (error.name !== 'AbortError') {
        setChatError(error.message || 'The local model could not create a draft.');
      }
      return false;
    } finally {
      if (draftRequestRef.current === controller) {
        draftRequestRef.current = null;
        isGeneratingDraftRef.current = false;
        setIsGeneratingDraft(false);
      }
    }
  };

  const processVoiceTranscriptQueue = async () => {
    if (voiceTranscriptProcessingRef.current) return;
    voiceTranscriptProcessingRef.current = true;
    while (voiceTranscriptQueueRef.current.length > 0) {
      while (isGeneratingDraftRef.current && voiceTranscriptQueueRef.current.length > 0) {
        await new Promise((resolve) => window.setTimeout(resolve, 50));
      }
      if (voiceTranscriptQueueRef.current.length === 0) break;
      const transcript = voiceTranscriptQueueRef.current.shift();
      const generated = await requestDraft(
        transcript.text,
        chatMessagesRef.current,
        null,
        transcript.receivedAt,
      );
      if (voiceTranscriptQueueRef.current.length === 0) {
        setVoiceStatus(
          generated
            ? 'Draft ready. Review it and press Play only when you approve the spoken reply.'
            : 'The voice turn was transcribed, but a draft could not be generated. Check the draft error.',
        );
      }
    }
    voiceTranscriptProcessingRef.current = false;
  };

  const startVoiceSession = async () => {
    if (voiceSessionRef.current || isStartingVoiceSession) return;
    setVoiceError('');
    setShowMicrophonePermissionHelp(false);
    const AudioContextType = window.AudioContext || window.webkitAudioContext;
    if (!navigator.mediaDevices?.getUserMedia || !AudioContextType || !window.AudioWorkletNode) {
      setVoiceError('This browser does not support live microphone streaming. Use a current browser in a secure context.');
      return;
    }
    if (!speechStatus?.streaming_transcription?.available) {
      setVoiceError('Local streaming transcription is unavailable. Follow the audio setup instructions in the voice-service README.');
      return;
    }

    voiceStartupCancelledRef.current = false;
    setIsStartingVoiceSession(true);
    setVoiceStatus('Connecting the microphone to the local voice service…');
    let stream;
    let context;
    let session;
    try {
      const audio = {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      };
      if (microphoneId) audio.deviceId = { exact: microphoneId };
      stream = await navigator.mediaDevices.getUserMedia({ audio });
      if (voiceStartupCancelledRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      void refreshAudioDevices().catch((error) => {
        setVoiceError(`Could not refresh audio devices: ${error.message}`);
      });
      context = new AudioContextType();
      await context.audioWorklet.addModule('/harry-botter-pcm-worklet.js');
      if (voiceStartupCancelledRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        await context.close();
        return;
      }
      const source = context.createMediaStreamSource(stream);
      const worklet = new window.AudioWorkletNode(context, 'harry-botter-pcm', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
      });
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const socket = new window.WebSocket(
        `${protocol}//${window.location.host}/api/harry-botter/stream`,
        [`edu-auth.${teacherSession.token}`],
      );
      session = {
        stream,
        context,
        source,
        worklet,
        socket,
        sessionId: crypto.randomUUID(),
        lastSequence: 0,
        stopping: false,
        tracksStopped: false,
        contextClosing: false,
        stopTimer: null,
        readyTimer: null,
        resolveReady: null,
        rejectReady: null,
      };
      voiceSessionRef.current = session;
      worklet.port.onmessage = (event) => {
        if (
          voiceSessionRef.current === session
          && !session.stopping
          && socket.readyState === window.WebSocket.OPEN
          && event.data?.type === 'audio'
        ) {
          socket.send(event.data.frame);
        }
      };
      socket.onmessage = (event) => {
        if (voiceSessionRef.current !== session) return;
        let message;
        try {
          message = JSON.parse(event.data);
        } catch {
          setVoiceError('The local voice service sent an invalid event.');
          stopVoiceSession('Voice conversation ended after an invalid service event.');
          return;
        }
        if (session.suppressTranscriptEvents && message.type !== 'stopped') return;
        if (message.session_id && message.session_id !== session.sessionId) return;
        if (message.type === 'ready') {
          session.ready = true;
          session.resolveReady?.();
          setIsVoiceSessionActive(true);
          setVoiceStatus('Listening locally. Speak naturally; each recognized turn will create a draft.');
          source.connect(worklet);
          worklet.connect(context.destination);
          return;
        }
        if (message.type === 'error') {
          setVoiceError(message.message || 'The local voice service could not process audio.');
          session.rejectReady?.(new Error(message.message || 'The local voice service could not start.'));
          return;
        }
        if (message.type === 'stopped') {
          finishVoiceSession(session, 'Voice conversation stopped.');
          return;
        }
        if (typeof message.sequence === 'number') {
          if (message.sequence <= session.lastSequence) return;
          session.lastSequence = message.sequence;
        }
        if (message.type === 'speech_started') {
          if (speechAudioRef.current && !speechAudioRef.current.paused) {
            stopSpeechPlayback();
          }
          setVoiceStatus('Speech detected; waiting for the end of your utterance…');
        } else if (message.type === 'transcript_final') {
          const transcript = message.text?.trim();
          if (!transcript) return;
          setChatText(transcript);
          setVoiceStatus('Transcript received locally. Generating a reviewable draft…');
          voiceTranscriptQueueRef.current.push({
            text: transcript,
            receivedAt: performance.now(),
          });
          void processVoiceTranscriptQueue();
        } else if (message.type === 'speech_not_recognized') {
          setVoiceStatus('No speech was recognized. Keep speaking clearly or try again.');
        } else if (message.type === 'speech_ended') {
          setVoiceStatus('Utterance transcribed locally.');
        }
      };
      socket.onclose = () => {
        if (!session.ready) {
          session.rejectReady?.(new Error('The local voice service closed before it became ready.'));
        }
        finishVoiceSession(
          session,
          session.stopping ? 'Voice conversation stopped.' : 'The local voice connection closed.',
        );
      };
      socket.onerror = () => {
        if (voiceSessionRef.current !== session) return;
        setVoiceError('Could not connect to the authenticated local voice stream. Check that the backend and voice service are running.');
      };

      const waitForSocketOpen = new Promise((resolve, reject) => {
        const timer = window.setTimeout(
          () => reject(new Error('The local voice stream did not open in time.')),
          10_000,
        );
        socket.addEventListener('open', () => {
          window.clearTimeout(timer);
          resolve();
        }, { once: true });
        socket.addEventListener('error', () => {
          window.clearTimeout(timer);
          reject(new Error('Could not open the authenticated local voice stream.'));
        }, { once: true });
        socket.addEventListener('close', () => {
          window.clearTimeout(timer);
          reject(new Error('The local voice stream closed before it opened.'));
        }, { once: true });
      });
      const waitForReady = new Promise((resolve, reject) => {
        session.resolveReady = () => {
          window.clearTimeout(session.readyTimer);
          resolve();
        };
        session.rejectReady = (error) => {
          window.clearTimeout(session.readyTimer);
          reject(error);
        };
        session.readyTimer = window.setTimeout(
          () => reject(new Error('The local voice service did not become ready in time.')),
          10_000,
        );
      });
      await context.resume();
      await waitForSocketOpen;
      socket.send(JSON.stringify({
        type: 'start',
        session_id: session.sessionId,
        sample_rate: 16_000,
        format: 'pcm_s16le_mono',
      }));
      await waitForReady;
    } catch (error) {
      if (session) {
        finishVoiceSession(session, 'Voice conversation could not be started.');
      } else {
        stream?.getTracks().forEach((track) => track.stop());
        if (context?.state !== 'closed') void context?.close();
      }
      if (!voiceStartupCancelledRef.current) {
        setShowMicrophonePermissionHelp(
          error?.name === 'NotAllowedError' || error?.name === 'SecurityError',
        );
        setVoiceError(
          error?.name === 'NotAllowedError' || error?.name === 'SecurityError'
            ? getMicrophoneAccessErrorMessage(error)
            : error.message || 'Could not start the local voice conversation.',
        );
      }
    } finally {
      setIsStartingVoiceSession(false);
    }
  };

  const sendChatMessage = (event) => {
    event.preventDefault();
    const text = chatText.trim();
    if (!text || isGeneratingDraft) return;
    void requestDraft(text, chatMessages);
  };

  const regenerateDraft = (draftIndex) => {
    let userIndex = draftIndex - 1;
    while (userIndex >= 0 && chatMessages[userIndex].role !== 'user') userIndex -= 1;
    if (userIndex < 0 || isGeneratingDraft) return;
    const userText = chatMessages[userIndex].content;
    void requestDraft(userText, chatMessages.slice(0, userIndex), draftIndex);
  };

  const saveEditedDraft = (draftIndex) => {
    const text = editedDraftText.trim();
    if (!text) return;
    if (playingSpeechIndex === draftIndex) stopSpeechPlayback();
    if (isPreparingSpeechIndex === draftIndex) cancelSpeechGeneration();
    setChatMessages((messages) => messages.map((message, index) => {
      if (index !== draftIndex) return message;
      const updatedMessage = { ...message, content: text };
      delete updatedMessage.speechUrl;
      return updatedMessage;
    }));
    setEditingDraftIndex(null);
    setEditedDraftText('');
  };

  const dismissDraft = (draftIndex) => {
    if (playingSpeechIndex === draftIndex) stopSpeechPlayback();
    if (isPreparingSpeechIndex === draftIndex) cancelSpeechGeneration();
    setChatMessages((messages) => messages.filter((_, index) => index !== draftIndex));
    setEditingDraftIndex(null);
    setEditedDraftText('');
  };

  const stopSpeechPlayback = () => {
    const audio = speechAudioRef.current;
    if (audio) {
      audio.pause();
      audio.currentTime = 0;
      speechAudioRef.current = null;
    }
    setPlayingSpeechIndex(null);
  };

  const cancelSpeechGeneration = () => {
    const request = speechRequestRef.current;
    if (!request) return;
    speechRequestRef.current = null;
    request.controller.abort();
    setIsPreparingSpeechIndex(null);
  };

  const transcribeRecording = async () => {
    if (!recordingBlob || isTranscribingRecording) return;
    setAudioError('');
    setIsTranscribingRecording(true);
    try {
      const response = await fetch('/api/harry-botter/transcribe', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${teacherSession.token}`,
          'Content-Type': recordingBlob.type || 'audio/webm',
        },
        body: recordingBlob,
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.detail || 'Could not transcribe this recording locally.');
      if (!result.transcript?.trim()) {
        throw new Error('No speech was recognized. Try a clearer, longer recording.');
      }
      setChatText(result.transcript);
      setPreviewMode('text');
      setAudioStatus(`Local transcription ready${result.model ? ` (${result.model})` : ''}. Review it before generating a draft.`);
    } catch (error) {
      setAudioError(error.message || 'Could not transcribe this recording locally.');
    } finally {
      setIsTranscribingRecording(false);
    }
  };

  const prepareSpokenDraft = async (draftIndex, text) => {
    if (isPreparingSpeechIndex !== null) return;
    setSpeechError('');
    setIsPreparingSpeechIndex(draftIndex);
    const controller = new AbortController();
    const request = { controller, draftIndex };
    speechRequestRef.current = request;
    try {
      const response = await fetch('/api/harry-botter/speech', {
        method: 'POST',
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${teacherSession.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ text, speed: speechSpeed }),
      });
      if (!response.ok) {
        const result = await response.json();
        throw new Error(result.detail || 'Could not generate local speech.');
      }
      const audioBlob = await response.blob();
      if (controller.signal.aborted || speechRequestRef.current !== request) return;
      if (audioBlob.type !== 'audio/wav') throw new Error('The local speech service returned an unsupported audio type.');
      const nextUrl = URL.createObjectURL(audioBlob);
      speechUrlsRef.current.add(nextUrl);
      const previousSpeechUrl = chatMessages[draftIndex]?.speechUrl;
      if (previousSpeechUrl) {
        URL.revokeObjectURL(previousSpeechUrl);
        speechUrlsRef.current.delete(previousSpeechUrl);
      }
      setChatMessages((messages) => messages.map((message, index) => {
        if (index !== draftIndex || message.role !== 'assistant') return message;
        return { ...message, speechUrl: nextUrl };
      }));
    } catch (error) {
      if (error.name !== 'AbortError') {
        setSpeechError(error.message || 'Could not generate local speech.');
      }
    } finally {
      if (speechRequestRef.current === request) {
        speechRequestRef.current = null;
        setIsPreparingSpeechIndex(null);
      }
    }
  };

  const updateAgentDraft = (field, value) => {
    setAgentDraft((current) => ({ ...(current || EMPTY_AGENT_DRAFT), [field]: value }));
  };

  const saveAgent = async (event) => {
    event.preventDefault();
    if (!agentDraft || isSavingAgent) return;
    setConfigError('');
    setIsSavingAgent(true);
    try {
      const payload = {
        display_name: agentDraft.display_name,
        purpose: agentDraft.purpose,
        instructions: agentDraft.instructions,
        generation_temperature: Number(agentDraft.generation_temperature),
        generation_max_tokens: Number(agentDraft.generation_max_tokens),
      };
      const isExisting = Boolean(agentDraft.agent_id);
      const response = await fetch(
        isExisting
          ? `/api/harry-botter/agents/${encodeURIComponent(agentDraft.agent_id)}`
          : '/api/harry-botter/agents',
        {
          method: isExisting ? 'PUT' : 'POST',
          headers: {
            Authorization: `Bearer ${teacherSession.token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(payload),
        },
      );
      const result = await response.json();
      if (!response.ok) throw new Error(result.detail || 'Could not save this agent.');
      setAgentDraft(result.agent);
      setSelectedAgentId(result.agent.agent_id);
      await loadConfiguration();
      setKnowledgeStatus(`${result.agent.display_name} saved for all teacher accounts.`);
    } catch (error) {
      setConfigError(error.message || 'Could not save this agent.');
    } finally {
      setIsSavingAgent(false);
    }
  };

  const startNewAgent = () => {
    setSelectedAgentId('__new__');
    setAgentDraft({ ...EMPTY_AGENT_DRAFT });
    setConfigError('');
    setKnowledgeStatus('');
  };

  const selectAgent = (event) => {
    const nextId = event.target.value;
    setSelectedAgentId(nextId);
    setAgentDraft(
      nextId === '__new__'
        ? { ...EMPTY_AGENT_DRAFT }
        : agents.find((agent) => agent.agent_id === nextId) || null,
    );
    setConfigError('');
  };

  const deleteAgent = async () => {
    if (!agentDraft?.agent_id || agentDraft.is_builtin) return;
    if (!window.confirm(`Delete “${agentDraft.display_name}” and its agent-specific documents?`)) return;
    setConfigError('');
    try {
      const response = await fetch(
        `/api/harry-botter/agents/${encodeURIComponent(agentDraft.agent_id)}`,
        { method: 'DELETE', headers: { Authorization: `Bearer ${teacherSession.token}` } },
      );
      const result = await response.json();
      if (!response.ok) throw new Error(result.detail || 'Could not delete this agent.');
      setAgentDraft(null);
      setSelectedAgentId('general');
      await loadConfiguration();
      setKnowledgeStatus('Agent deleted.');
    } catch (error) {
      setConfigError(error.message || 'Could not delete this agent.');
    }
  };

  const handleKnowledgeFileChange = async (event) => {
    const file = event.currentTarget.files[0];
    if (!file) return;
    setKnowledgeError('');
    if (file.size > MAX_KNOWLEDGE_BYTES) {
      setKnowledgeError('Knowledge files must be 100 KB or smaller.');
      return;
    }
    if (!/\.(txt|md)$/i.test(file.name)) {
      setKnowledgeError('Only plain-text .txt and .md files are supported.');
      return;
    }
    setIsReadingKnowledge(true);
    try {
      const text = await file.text();
      setKnowledgeDraft((current) => ({ ...current, filename: file.name, text }));
    } catch (error) {
      setKnowledgeError(error.message || 'Could not read this reference file.');
    } finally {
      setIsReadingKnowledge(false);
    }
  };

  const uploadKnowledge = async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const file = form.elements.knowledgeFile.files[0];
    setKnowledgeError('');
    setKnowledgeStatus('');
    if (!file && !editingKnowledgeId) {
      setKnowledgeError('Choose a .txt or .md file to upload.');
      return;
    }
    if (file && file.size > MAX_KNOWLEDGE_BYTES) {
      setKnowledgeError('Knowledge files must be 100 KB or smaller.');
      return;
    }
    const filename = file?.name || knowledgeDraft.filename;
    if (!/\.(txt|md)$/i.test(filename)) {
      setKnowledgeError('Only plain-text .txt and .md files are supported.');
      return;
    }
    if (!knowledgeDraft.text.trim()) {
      setKnowledgeError('Reference content must contain readable text.');
      return;
    }
    if (new TextEncoder().encode(knowledgeDraft.text).length > MAX_KNOWLEDGE_BYTES) {
      setKnowledgeError('Knowledge files must be 100 KB or smaller.');
      return;
    }
    setIsUploadingKnowledge(true);
    try {
      const response = await fetch(
        editingKnowledgeId
          ? `/api/harry-botter/knowledge/${encodeURIComponent(editingKnowledgeId)}`
          : '/api/harry-botter/knowledge',
        {
        method: editingKnowledgeId ? 'PUT' : 'POST',
        headers: {
          Authorization: `Bearer ${teacherSession.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          ...knowledgeDraft,
          review_date: knowledgeDraft.review_date || null,
          filename,
        }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.detail || 'Could not save this reference.');
      const wasEditing = Boolean(editingKnowledgeId);
      setEditingKnowledgeId(null);
      setKnowledgeDraft({
        filename: '',
        title: '',
        source: '',
        owner: '',
        learning_level: '',
        agent_id: '',
        review_date: '',
        text: '',
        permission_confirmed: false,
      });
      form.reset();
      await loadConfiguration();
      setKnowledgeStatus(
        `${wasEditing ? 'Updated' : 'Added'} “${result.document.title}” in the shared local knowledge library.`,
      );
    } catch (error) {
      setKnowledgeError(error.message || 'Could not save this reference.');
    } finally {
      setIsUploadingKnowledge(false);
    }
  };

  const editKnowledge = async (documentId) => {
    setKnowledgeError('');
    setKnowledgeStatus('');
    try {
      const response = await fetch(
        `/api/harry-botter/knowledge/${encodeURIComponent(documentId)}`,
        { headers: { Authorization: `Bearer ${teacherSession.token}` } },
      );
      const result = await response.json();
      if (!response.ok) throw new Error(result.detail || 'Could not load this reference.');
      const document = result.document;
      setEditingKnowledgeId(document.document_id);
      setKnowledgeDraft({
        filename: document.filename,
        title: document.title,
        source: document.source,
        owner: document.owner,
        learning_level: document.learning_level || '',
        agent_id: document.agent_id || '',
        review_date: document.review_date || '',
        text: document.text,
        permission_confirmed: true,
      });
    } catch (error) {
      setKnowledgeError(error.message || 'Could not load this reference.');
    }
  };

  const cancelKnowledgeEdit = () => {
    setEditingKnowledgeId(null);
    setKnowledgeDraft({
      filename: '',
      title: '',
      source: '',
      owner: '',
      learning_level: '',
      agent_id: '',
      review_date: '',
      text: '',
      permission_confirmed: false,
    });
    setKnowledgeError('');
  };

  const deleteKnowledge = async (documentId) => {
    const document = knowledgeDocuments.find((item) => item.document_id === documentId);
    if (!window.confirm(`Delete “${document?.title || 'this reference'}” from the shared knowledge library?`)) return;
    setKnowledgeError('');
    setKnowledgeStatus('');
    try {
      const response = await fetch(
        `/api/harry-botter/knowledge/${encodeURIComponent(documentId)}`,
        { method: 'DELETE', headers: { Authorization: `Bearer ${teacherSession.token}` } },
      );
      const result = await response.json();
      if (!response.ok) throw new Error(result.detail || 'Could not delete this reference.');
      if (editingKnowledgeId === documentId) cancelKnowledgeEdit();
      await loadConfiguration();
      setKnowledgeStatus('Reference deleted from the shared local knowledge library.');
    } catch (error) {
      setKnowledgeError(error.message || 'Could not delete this reference.');
    }
  };

  const startMicrophoneTest = async () => {
    setAudioError('');
    setShowMicrophonePermissionHelp(false);
    if (!navigator.mediaDevices?.getUserMedia) {
      setAudioError('Microphone access is not available. Use a supported browser in a secure context.');
      return;
    }
    if (typeof MediaRecorder === 'undefined') {
      setAudioError('This browser does not support recording a microphone test.');
      return;
    }

    let stream;
    try {
      const audioConstraints = microphoneId
        ? { deviceId: { exact: microphoneId } }
        : true;
      stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });
      streamRef.current = stream;
      const recorder = new MediaRecorder(stream);
      audioChunksRef.current = [];
      setRecordingBlob(null);
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) audioChunksRef.current.push(event.data);
      };
      recorder.onstop = () => {
        if (recordingTimerRef.current !== null) {
          window.clearTimeout(recordingTimerRef.current);
          recordingTimerRef.current = null;
        }
        const recording = new Blob(audioChunksRef.current, {
          type: recorder.mimeType || 'audio/webm',
        });
        audioChunksRef.current = [];
        if (recording.size > 0) {
          setRecordingBlob(recording);
          const nextUrl = URL.createObjectURL(recording);
          if (recordingUrlRef.current) URL.revokeObjectURL(recordingUrlRef.current);
          recordingUrlRef.current = nextUrl;
          setRecordingUrl(nextUrl);
          setAudioStatus('Microphone test saved temporarily in this browser. Play it to check your speaker.');
        } else {
          setAudioError('The microphone produced an empty recording. Check the selected device and try again.');
        }
        stream.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
        recorderRef.current = null;
        setIsRecording(false);
        void refreshAudioDevices().catch((error) => {
          setAudioError(`Could not refresh audio devices: ${error.message}`);
        });
      };
      recorderRef.current = recorder;
      recorder.start();
      setIsRecording(true);
      setAudioStatus('Recording locally in this browser. Nothing is being uploaded.');
      recordingTimerRef.current = window.setTimeout(() => {
        if (recorderRef.current === recorder && recorder.state === 'recording') {
          setAudioStatus('The 30-second microphone test limit was reached; finishing the recording.');
          recorder.stop();
        }
      }, 30_000);
      await refreshAudioDevices();
    } catch (error) {
      const recorder = recorderRef.current;
      if (recorder && recorder.state !== 'inactive') {
        recorder.onstop = null;
        recorder.stop();
      }
      if (recordingTimerRef.current !== null) {
        window.clearTimeout(recordingTimerRef.current);
        recordingTimerRef.current = null;
      }
      stream?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      recorderRef.current = null;
      setIsRecording(false);
      setShowMicrophonePermissionHelp(
        error?.name === 'NotAllowedError' || error?.name === 'SecurityError',
      );
      setAudioError(`Could not start the microphone test. ${getMicrophoneAccessErrorMessage(error)}`);
    }
  };

  const stopMicrophoneTest = () => {
    const recorder = recorderRef.current;
    if (recorder?.state === 'recording') {
      if (recordingTimerRef.current !== null) {
        window.clearTimeout(recordingTimerRef.current);
        recordingTimerRef.current = null;
      }
      recorder.stop();
      setAudioStatus('Finishing microphone test…');
    }
  };

  const selectPreviewMode = (mode) => {
    if (mode !== previewMode) {
      voiceStartupCancelledRef.current = true;
      if (isRecording) stopMicrophoneTest();
      if (voiceSessionRef.current) stopVoiceSession('Voice conversation closed.');
      cancelSpeechGeneration();
      stopSpeechPlayback();
    }
    setPreviewMode(mode);
  };

  const handleSpeakerChange = async (event) => {
    const nextSpeakerId = event.target.value;
    setSpeakerId(nextSpeakerId);
    setAudioError('');
    const audioElement = audioElementRef.current;
    if (audioElement && typeof audioElement.setSinkId === 'function') {
      try {
        await audioElement.setSinkId(nextSpeakerId);
      } catch (error) {
        setAudioError(`Could not select that speaker: ${error.message}`);
      }
    } else if (nextSpeakerId) {
      setAudioError('This browser cannot select output devices; playback will use its default speaker.');
    }
  };

  const deleteRecording = () => {
    if (recordingUrlRef.current) URL.revokeObjectURL(recordingUrlRef.current);
    recordingUrlRef.current = '';
    audioChunksRef.current = [];
    setRecordingBlob(null);
    setRecordingUrl('');
    setAudioStatus('Temporary microphone recording deleted.');
  };

  const handleLogout = () => {
    voiceStartupCancelledRef.current = true;
    if (voiceSessionRef.current) {
      voiceSessionRef.current.suppressTranscriptEvents = true;
    }
    draftRequestRef.current?.abort();
    draftRequestRef.current = null;
    isGeneratingDraftRef.current = false;
    setIsGeneratingDraft(false);
    stopVoiceSession('Signed out; voice conversation stopped.');
    voiceTranscriptQueueRef.current = [];
    cancelSpeechGeneration();
    stopSpeechPlayback();
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== 'inactive') {
      recorder.onstop = null;
      recorder.stop();
    }
    if (recordingTimerRef.current !== null) {
      window.clearTimeout(recordingTimerRef.current);
      recordingTimerRef.current = null;
    }
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    recorderRef.current = null;
    setIsRecording(false);
    localStorage.removeItem(SESSION_STORAGE_KEY);
    setTeacherSession(null);
    setModelStatus(null);
    setG1RobotStatus(null);
    setDraftOutput('browser');
    setG1SpeechStatus('');
    setG1SpeechError('');
    setChatMessages([]);
    setEditingDraftIndex(null);
    setEditedDraftText('');
    setChatText('');
    setChatError('');
    setCredentials({ username: '', password: '' });
    deleteRecording();
    setAudioStatus('No microphone test has been recorded.');
  };

  if (!teacherSession) {
    return (
      <main className="min-h-screen bg-gradient-to-br from-blue-50 via-white to-slate-100 flex items-center justify-center p-6">
        <section className="w-full max-w-md overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl">
          <header className="bg-blue-700 px-6 py-5 text-white">
            <p className="text-sm font-semibold uppercase tracking-wide text-blue-100">Browser preview</p>
            <h1 className="mt-1 text-2xl font-bold">Try Harry Botter AI</h1>
            <p className="mt-2 text-sm text-blue-100">Sign in with your existing Uni-EDU teacher account.</p>
          </header>
          <form onSubmit={handleLogin} className="space-y-4 p-6">
            <label className="block text-sm font-medium text-slate-700">
              Username
              <input
                autoComplete="username"
                required
                value={credentials.username}
                onChange={(event) => setCredentials({ ...credentials, username: event.target.value })}
                className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </label>
            <label className="block text-sm font-medium text-slate-700">
              Password
              <input
                type="password"
                autoComplete="current-password"
                required
                value={credentials.password}
                onChange={(event) => setCredentials({ ...credentials, password: event.target.value })}
                className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </label>
            {loginError && <p role="alert" className="text-sm text-red-700">{loginError}</p>}
            <button
              type="submit"
              disabled={isLoggingIn}
              className="w-full rounded-xl bg-blue-700 py-2.5 font-semibold text-white hover:bg-blue-800 disabled:cursor-wait disabled:opacity-60"
            >
              {isLoggingIn ? 'Signing in…' : 'Sign in as teacher'}
            </button>
            <p className="text-xs leading-relaxed text-slate-500">
              This uses the existing classroom login. It does not create or prefill a shared test password.
            </p>
            <a href="/" className="block text-center text-sm font-semibold text-blue-700 hover:underline">
              Back to Uni-EDU sign in
            </a>
          </form>
        </section>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-slate-50 p-4 text-slate-800 sm:p-8">
      <div className="mx-auto max-w-4xl space-y-6">
        <header className="flex flex-wrap items-start justify-between gap-4 rounded-2xl bg-blue-700 p-6 text-white shadow">
          <div>
            <p className="text-sm font-semibold uppercase tracking-wide text-blue-100">Teacher preview</p>
            <h1 className="mt-1 text-3xl font-bold">Harry Botter</h1>
            <p className="mt-2 text-sm text-blue-100">
              Local-model text drafts, transcription, and approved speech playback.
            </p>
          </div>
          <div className="flex gap-3">
            <a href="/" className="rounded-lg border border-white/40 px-4 py-2 text-sm font-semibold hover:bg-white/10">
              Uni-EDU Studio
            </a>
            <button type="button" onClick={handleLogout} className="rounded-lg bg-white px-4 py-2 text-sm font-semibold text-blue-800 hover:bg-blue-50">
              Sign out
            </button>
          </div>
        </header>

        <section className="rounded-2xl border border-amber-200 bg-amber-50 p-5 text-sm text-amber-950">
          <h2 className="font-semibold">Voice conversations run locally with explicit review</h2>
          <p className="mt-1">
            In voice mode, the browser sends temporary 16 kHz microphone frames through the teacher-authenticated backend to local voice activity detection and Whisper. Each recognized turn creates a reviewable draft with the configured local LLM. Spoken replies are synthesized locally and are never played until you press Play. Speaker diarization and barge-in are not implemented.
          </p>
          <p className="mt-2">
            Embedded VS Code or Codespaces previews may block microphone access. A webpage cannot open or change browser permission settings, so use a full browser tab to manage this permission.
          </p>
          <p className="mt-2">
            When this app runs in Codespaces, microphone recordings travel to the remote workspace over its authenticated connection. For audio to stay on your own computer, run the app, backend, and speech service from a local checkout.
          </p>
          <a
            href={window.location.href}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-2 inline-block font-semibold underline underline-offset-2"
          >
            Open this preview in a full browser tab
          </a>
        </section>

        <section
          aria-label="Preview mode"
          className="flex flex-wrap items-center gap-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm"
        >
          <span className="text-sm font-semibold text-slate-700">Choose a test mode:</span>
          <button
            type="button"
            aria-pressed={previewMode === 'text'}
            onClick={() => selectPreviewMode('text')}
            className={`rounded-lg px-4 py-2 text-sm font-semibold ${
              previewMode === 'text'
                ? 'bg-blue-700 text-white'
                : 'border border-slate-300 text-slate-700 hover:bg-slate-50'
            }`}
          >
            Typing chat
          </button>
          <button
            type="button"
            aria-pressed={previewMode === 'microphone'}
            onClick={() => selectPreviewMode('microphone')}
            className={`rounded-lg px-4 py-2 text-sm font-semibold ${
              previewMode === 'microphone'
                ? 'bg-blue-700 text-white'
                : 'border border-slate-300 text-slate-700 hover:bg-slate-50'
            }`}
          >
            Microphone test
          </button>
          <button
            type="button"
            aria-pressed={previewMode === 'voice'}
            onClick={() => selectPreviewMode('voice')}
            className={`rounded-lg px-4 py-2 text-sm font-semibold ${
              previewMode === 'voice'
                ? 'bg-blue-700 text-white'
                : 'border border-slate-300 text-slate-700 hover:bg-slate-50'
            }`}
          >
            Voice conversation
          </button>
          <span className="text-xs text-slate-500">
            Type, test your devices, or converse with the local streaming voice path. Spoken replies require your explicit playback.
          </span>
          <label className="ml-auto flex items-center gap-2 text-sm font-medium text-slate-700">
            Spoken reply pace
            <select
              aria-label="Spoken reply pace"
              value={speechSpeed}
              onChange={(event) => setSpeechSpeed(Number(event.target.value))}
              className="rounded-lg border border-slate-300 bg-white px-3 py-2"
            >
              <option value={0.85}>Slower</option>
              <option value={1}>Normal</option>
              <option value={1.15}>Faster</option>
            </select>
          </label>
          <label className="flex items-center gap-2 text-sm font-medium text-slate-700">
            Draft output
            <select
              aria-label="Draft audio output"
              value={draftOutput}
              onChange={(event) => {
                setDraftOutput(event.target.value);
                setG1SpeechStatus('');
                setG1SpeechError('');
              }}
              className="rounded-lg border border-slate-300 bg-white px-3 py-2"
            >
              <option value="browser">Browser/local speaker (default)</option>
              {g1AudioConnected && <option value="g1">G1 speaker</option>}
            </select>
          </label>
          <button
            type="button"
            onClick={() => void checkG1AudioStatus()}
            className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-semibold hover:bg-slate-50"
          >
            Refresh G1 audio status
          </button>
          <p role="status" aria-live="polite" className="w-full text-xs text-slate-600">
            {g1AudioConnected
              ? 'G1 audio client connected. Selecting G1 will not send audio; use the explicit speak button on a draft.'
              : g1RobotStatus?.error
                ? `G1 audio status unavailable. ${g1RobotStatus.error}`
                : g1RobotStatus
                  ? 'G1 speaker unavailable. Connect the G1 audio client from the teacher robot panel.'
                  : 'Checking G1 audio connection…'}
          </p>
          {draftOutput === 'g1' && g1AudioConnected && (
            <label className="flex items-center gap-2 text-sm font-medium text-slate-700">
              G1 speaker ID
              <select
                aria-label="G1 speaker ID"
                value={g1SpeakerId}
                onChange={(event) => setG1SpeakerId(event.target.value)}
                className="rounded-lg border border-slate-300 bg-white px-3 py-2"
              >
                <option value="0">Voice 0</option>
                <option value="1">Voice 1</option>
              </select>
            </label>
          )}
          {g1SpeechStatus && (
            <p role="status" aria-live="polite" className="w-full text-sm text-emerald-700">{g1SpeechStatus}</p>
          )}
          {g1SpeechError && (
            <p role="alert" className="w-full text-sm text-red-700">{g1SpeechError}</p>
          )}
        </section>

        {previewMode === 'text' && (
          <>
        <section className="space-y-4 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold">Local AI draft chat</h2>
              <p className="mt-1 text-sm text-slate-600">
                Teacher testing mode. Replies remain drafts; create speech and press Play only when you approve it.
              </p>
            </div>
            <button
              type="button"
              onClick={() => void checkLocalModel()}
              disabled={isCheckingModel}
              className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-semibold hover:bg-slate-50 disabled:opacity-60"
            >
              {isCheckingModel ? 'Checking…' : 'Check local model'}
            </button>
            <button
              type="button"
              onClick={() => {
                cancelSpeechGeneration();
                stopSpeechPlayback();
                setChatMessages([]);
                setEditingDraftIndex(null);
                setEditedDraftText('');
                setChatError('');
              }}
              disabled={chatMessages.length === 0 || isGeneratingDraft || isPreparingSpeechIndex !== null}
              className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-semibold hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Clear chat
            </button>
          </div>
          <div role="status" aria-live="polite" className="rounded-lg bg-slate-100 p-3 text-sm text-slate-700">
            {isCheckingModel && 'Checking the local model service…'}
            {!isCheckingModel && modelStatus?.status === 'ready'
              && `Local model ready: ${modelStatus.model}. Requests go only to the configured loopback server; there is no cloud fallback.`}
            {!isCheckingModel && modelStatus?.status === 'not_configured'
              && 'No local model is configured. Configure a loopback OpenAI-compatible model server and model name to enable drafts.'}
            {!isCheckingModel && modelStatus?.status === 'model_missing'
              && `The local server is running, but model “${modelStatus.model}” is not available there.`}
            {!isCheckingModel && modelStatus?.status === 'unavailable'
              && `The configured local model server is unavailable. ${modelStatus.error || 'Check that it is running.'}`}
            {!isCheckingModel && modelStatus?.status === 'service_unavailable'
              && `Harry Botter local service is unavailable. ${modelStatus.error || ''}`}
            {!isCheckingModel && !modelStatus && 'Local model status has not been checked.'}
          </div>

          <div className="max-h-96 space-y-3 overflow-y-auto rounded-lg border border-slate-200 p-4">
            {chatMessages.length === 0 && (
              <p className="text-sm text-slate-500">Type a message or record a voice turn for local transcription.</p>
            )}
            {chatMessages.map((message, index) => (
              <article
                key={`${index}-${message.role}`}
                className={`rounded-lg p-3 text-sm ${message.role === 'user' ? 'bg-blue-50' : 'bg-amber-50'}`}
              >
                <p className="font-semibold">
                  {message.role === 'user'
                    ? 'Your message'
                    : message.source === 'stage_policy'
                      ? 'Stage required'
                      : `AI draft${message.model ? ` · ${message.model}` : ''}`}
                </p>
                {editingDraftIndex === index ? (
                  <div className="mt-2 space-y-2">
                    <textarea
                      aria-label="Edit AI draft"
                      maxLength={12_000}
                      rows={5}
                      value={editedDraftText}
                      onChange={(event) => setEditedDraftText(event.target.value)}
                      className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2"
                    />
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={() => saveEditedDraft(index)}
                        disabled={!editedDraftText.trim()}
                        className="rounded-lg bg-blue-700 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
                      >
                        Save edited draft
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setEditingDraftIndex(null);
                          setEditedDraftText('');
                        }}
                        className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-semibold"
                      >
                        Cancel edit
                      </button>
                    </div>
                  </div>
                ) : (
                  <p className="mt-1 whitespace-pre-wrap">{message.content}</p>
                )}
                {Number.isFinite(message.transcriptToDraftMs) && (
                  <p className="mt-1 text-xs text-slate-500">
                    Draft returned in {(message.transcriptToDraftMs / 1000).toFixed(1)} s after transcript receipt.
                  </p>
                )}
                {message.sources?.length > 0 && (
                  <p className="mt-2 text-xs text-slate-600">
                    Reference context: {message.sources.map((source) => (
                      `${source.title} — ${source.source}${source.review_date ? ` (reviewed ${source.review_date})` : ''}`
                    )).join('; ')}
                  </p>
                )}
                {message.role === 'assistant' && (
                  <div className="mt-3 flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        setEditingDraftIndex(index);
                        setEditedDraftText(message.content);
                      }}
                      disabled={isGeneratingDraft || editingDraftIndex !== null}
                      className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-semibold disabled:opacity-50"
                    >
                      Edit draft
                    </button>
                    <button
                      type="button"
                      onClick={() => regenerateDraft(index)}
                      disabled={isGeneratingDraft || Boolean(!learningLevel)}
                      className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-semibold disabled:opacity-50"
                    >
                      Regenerate
                    </button>
                    <button
                      type="button"
                      onClick={() => dismissDraft(index)}
                      disabled={isGeneratingDraft}
                      className="rounded-lg border border-rose-300 px-3 py-1.5 text-xs font-semibold text-rose-700 disabled:opacity-50"
                    >
                      Dismiss draft
                    </button>
                    <button
                      type="button"
                      onClick={() => void prepareSpokenDraft(index, message.content)}
                      disabled={isPreparingSpeechIndex !== null || editingDraftIndex !== null}
                      className="rounded-lg border border-blue-300 px-3 py-1.5 text-xs font-semibold text-blue-800 disabled:opacity-50"
                    >
                      {isPreparingSpeechIndex === index ? 'Creating speech…' : 'Prepare spoken reply'}
                    </button>
                    {draftOutput === 'g1' && g1AudioConnected && (
                      <button
                        type="button"
                        onClick={() => void speakDraftOnG1(message.content)}
                        disabled={
                          isSendingG1Speech
                          || editingDraftIndex !== null
                          || !message.content.trim()
                          || message.content.length > MAX_G1_SPEECH_PREVIEW_CHARS
                        }
                        className="rounded-lg border border-emerald-300 px-3 py-1.5 text-xs font-semibold text-emerald-800 disabled:opacity-50"
                      >
                        {isSendingG1Speech ? 'Sending to G1…' : 'Speak this draft on G1'}
                      </button>
                    )}
                    {draftOutput === 'g1' && g1AudioConnected
                      && message.content.length > MAX_G1_SPEECH_PREVIEW_CHARS && (
                        <span className="self-center text-xs text-slate-600">
                          Shorten this draft to 120 characters before sending it to the G1.
                        </span>
                      )}
                  </div>
                )}
                {message.speechUrl && (
                  <div className="mt-3">
                    <audio
                      ref={(element) => {
                        if (!element && speechAudioRef.current?.dataset.speechIndex === String(index)) {
                          speechAudioRef.current = null;
                        }
                      }}
                      controls
                      src={message.speechUrl}
                      className="w-full"
                      aria-label={`Spoken draft ${index + 1}`}
                      data-speech-index={index}
                      onPlay={(event) => {
                        if (speechAudioRef.current && speechAudioRef.current !== event.currentTarget) {
                          speechAudioRef.current.pause();
                          speechAudioRef.current.currentTime = 0;
                        }
                        speechAudioRef.current = event.currentTarget;
                        setPlayingSpeechIndex(index);
                      }}
                      onPause={() => {
                        setPlayingSpeechIndex((current) => current === index ? null : current);
                      }}
                      onEnded={() => {
                        setPlayingSpeechIndex((current) => current === index ? null : current);
                      }}
                      onLoadedMetadata={(event) => {
                        if (typeof event.currentTarget.setSinkId === 'function') {
                          event.currentTarget.setSinkId(speakerId).catch((error) => {
                            setSpeechError(`Could not route speech to the selected speaker: ${error.message}`);
                          });
                        }
                      }}
                    />
                    {playingSpeechIndex === index && (
                      <button
                        type="button"
                        onClick={stopSpeechPlayback}
                        className="mt-2 rounded-lg border border-rose-300 px-3 py-1.5 text-xs font-semibold text-rose-700"
                      >
                        Stop spoken reply
                      </button>
                    )}
                  </div>
                )}
              </article>
            ))}
            {speechError && <p role="alert" className="text-sm text-red-700">{speechError}</p>}
            {isGeneratingDraft && <p role="status" className="text-sm text-slate-600">Generating a local draft…</p>}
          </div>

          <form onSubmit={sendChatMessage} className="space-y-3">
            <label className="block text-sm font-medium">
              Message
              <textarea
                value={chatText}
                onChange={(event) => setChatText(event.target.value)}
                maxLength={2000}
                rows={3}
                required
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
                placeholder="Ask Harry Botter a question…"
              />
            </label>
            {chatError && <p role="alert" className="text-sm text-red-700">{chatError}</p>}
            <button
              type="submit"
              disabled={
                !chatText.trim()
                || isGeneratingDraft
                || !agentDraft?.agent_id
                || (Boolean(learningLevel) && modelStatus?.status !== 'ready')
              }
              className="rounded-lg bg-blue-700 px-4 py-2 font-semibold text-white hover:bg-blue-800 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isGeneratingDraft ? 'Generating draft…' : 'Generate local draft'}
            </button>
          </form>
          <p className="text-xs leading-relaxed text-slate-500">
            Messages go through the teacher-authenticated app backend. Chat history stays in this page and is not saved by the service. When no programme/year is selected, the service asks for the stage without calling a model. Reference excerpts are selected locally and sent only to the configured loopback model. Audio playback is always prepared on request and requires you to press Play.
          </p>
        </section>
          </>
        )}

        {previewMode === 'microphone' && (
          <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <div className="mx-auto max-w-xl space-y-4">
            <div>
              <h2 className="text-lg font-semibold">Microphone and speaker test</h2>
              <p className="mt-1 text-sm text-slate-600">
                Record a short sample. You can play it locally or explicitly send it for local transcription.
              </p>
            </div>
            <label className="block text-sm font-medium">
              Microphone
              <select
                value={microphoneId}
                onChange={(event) => setMicrophoneId(event.target.value)}
                className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2"
              >
                <option value="">System default microphone</option>
                {microphones.map((device, index) => (
                  <option key={device.deviceId || `microphone-${index}`} value={device.deviceId}>
                    {device.label || `Microphone ${index + 1}`}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-sm font-medium">
              Speaker
              <select
                value={speakerId}
                onChange={handleSpeakerChange}
                className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2"
              >
                <option value="">System default speaker</option>
                {speakers.map((device, index) => (
                  <option key={device.deviceId || `speaker-${index}`} value={device.deviceId}>
                    {device.label || `Speaker ${index + 1}`}
                  </option>
                ))}
              </select>
            </label>
            <div className="flex flex-wrap gap-3">
              {isRecording ? (
                <button type="button" onClick={stopMicrophoneTest} className="rounded-lg bg-rose-700 px-4 py-2 font-semibold text-white hover:bg-rose-800">
                  Stop recording
                </button>
              ) : (
                <button type="button" onClick={startMicrophoneTest} className="rounded-lg bg-blue-700 px-4 py-2 font-semibold text-white hover:bg-blue-800">
                  Record microphone sample
                </button>
              )}
              {recordingUrl && (
                <button type="button" onClick={deleteRecording} className="rounded-lg border border-slate-300 px-4 py-2 font-semibold hover:bg-slate-50">
                  Delete recording
                </button>
              )}
              {recordingBlob && (
                <button
                  type="button"
                  onClick={() => void transcribeRecording()}
                  disabled={isTranscribingRecording || !speechStatus?.transcription?.available}
                  className="rounded-lg bg-blue-700 px-4 py-2 font-semibold text-white hover:bg-blue-800 disabled:opacity-50"
                >
                  {isTranscribingRecording ? 'Transcribing locally…' : 'Transcribe locally and review'}
                </button>
              )}
            </div>
            <div aria-live="polite" className="rounded-lg bg-slate-100 p-3 text-sm text-slate-700">
              {!speechStatus && 'Checking local speech setup…'}
              {speechStatus?.error && `Speech service unavailable. ${speechStatus.error}`}
              {speechStatus?.transcription && (
                speechStatus.transcription.available
                  ? `Local transcription model: ${speechStatus.transcription.model} (${speechStatus.transcription.device}).`
                  : 'Local transcription is not installed. Follow the audio setup instructions in the voice-service README.'
              )}
              {speechStatus?.speech_generation && (
                speechStatus.speech_generation.available
                  ? ` Local TTS package is installed; voice: ${speechStatus.speech_generation.voice}.`
                  : ' Local speech generation is not installed yet.'
              )}
            </div>
            <p className="text-xs text-slate-500">Recordings stop automatically after 30 seconds.</p>
            {recordingUrl && (
              <audio
                ref={audioElementRef}
                controls
                src={recordingUrl}
                className="w-full"
                onLoadedMetadata={(event) => {
                  if (typeof event.currentTarget.setSinkId === 'function') {
                    event.currentTarget.setSinkId(speakerId).catch((error) => {
                      setAudioError(`Could not route playback to the selected speaker: ${error.message}`);
                    });
                  }
                }}
              />
            )}
            <p aria-live="polite" className="text-sm text-slate-600">{audioStatus}</p>
            {audioError && <p role="alert" className="text-sm text-red-700">{audioError}</p>}
            {showMicrophonePermissionHelp && (
              <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">
                <p className="font-semibold">Allow microphone access in the browser tab</p>
                <p className="mt-1">
                  In the full browser tab, open the site controls or permissions icon beside the address bar and set Microphone to Allow. In Chrome or Edge, choose Site settings, then Microphone, then Allow. If the browser still blocks access, check your operating system microphone privacy settings.
                </p>
                <p className="mt-1">
                  Browsers do not let this page change those settings directly. If the preview link opened inside an editor, copy its address into Chrome, Edge, Firefox, or Safari.
                </p>
              </div>
            )}
            <p className="text-xs leading-relaxed text-slate-500">
              The recording stays temporarily in this browser until you explicitly select local transcription. It then passes through the teacher-authenticated backend to the loopback speech service and is not stored.
            </p>
          </div>
          </section>
        )}

        {previewMode === 'voice' && (
          <section className="space-y-5 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
            <div>
              <h2 className="text-lg font-semibold">Local voice conversation</h2>
              <p className="mt-1 text-sm text-slate-600">
                Speech is segmented locally. Recognized turns generate drafts automatically, but replies are never spoken without your explicit action.
              </p>
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              <label className="block text-sm font-medium">
                Learning stage
                <select
                  value={learningLevel}
                  onChange={(event) => setLearningLevel(event.target.value)}
                  disabled={isVoiceSessionActive}
                  className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2"
                >
                  <option value="">Choose before substantive answers</option>
                  {LEARNING_LEVELS.map((level) => <option key={level} value={level}>{level}</option>)}
                </select>
              </label>
              <label className="block text-sm font-medium">
                Tone
                <select
                  value={tone}
                  onChange={(event) => setTone(event.target.value)}
                  disabled={isVoiceSessionActive}
                  className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2"
                >
                  <option>Formal</option>
                  <option>Lightly humorous</option>
                </select>
              </label>
              <label className="block text-sm font-medium">
                Microphone
                <select
                  value={microphoneId}
                  onChange={(event) => setMicrophoneId(event.target.value)}
                  disabled={isVoiceSessionActive}
                  className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2"
                >
                  <option value="">System default microphone</option>
                  {microphones.map((device, index) => (
                    <option key={device.deviceId || `voice-microphone-${index}`} value={device.deviceId}>
                      {device.label || `Microphone ${index + 1}`}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="flex flex-wrap gap-3">
              {!isVoiceSessionActive ? (
                <button
                  type="button"
                  onClick={() => void startVoiceSession()}
                  disabled={isStartingVoiceSession || Boolean(voiceSessionRef.current)}
                  className="rounded-lg bg-blue-700 px-4 py-2 font-semibold text-white hover:bg-blue-800 disabled:cursor-wait disabled:opacity-50"
                >
                  {isStartingVoiceSession ? 'Connecting…' : 'Start voice conversation'}
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => stopVoiceSession()}
                  className="rounded-lg bg-rose-700 px-4 py-2 font-semibold text-white hover:bg-rose-800"
                >
                  Stop voice conversation
                </button>
              )}
              <button
                type="button"
                onClick={() => void refreshAudioDevices().catch((error) => {
                  setVoiceError(`Could not refresh audio devices: ${error.message}`);
                })}
                disabled={isVoiceSessionActive}
                className="rounded-lg border border-slate-300 px-4 py-2 font-semibold hover:bg-slate-50 disabled:opacity-50"
              >
                Refresh microphones
              </button>
            </div>
            <div role="status" aria-live="polite" className="rounded-lg bg-slate-100 p-3 text-sm text-slate-700">
              {voiceStatus}
              {!speechStatus && ' Checking local streaming setup…'}
              {speechStatus?.streaming_transcription
                && !speechStatus.streaming_transcription.available
                && ' Local streaming dependencies are missing; follow the voice-service README setup.'}
            </div>
            {voiceError && <p role="alert" className="text-sm text-red-700">{voiceError}</p>}
            {showMicrophonePermissionHelp && (
              <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">
                <p className="font-semibold">Allow microphone access in the browser tab</p>
                <p className="mt-1">
                  Open the site controls beside the address bar and set Microphone to Allow. If the preview is embedded, open it in a full browser tab. Also check your operating system microphone privacy settings.
                </p>
              </div>
            )}
            <p className="text-xs leading-relaxed text-slate-500">
              Microphone frames remain temporary in browser memory and are sent only to the loopback speech service through the authenticated backend. The service uses VAD to segment utterances and clears each segment after transcription. No audio or transcript is persisted.
            </p>
            <div className="max-h-96 space-y-3 overflow-y-auto rounded-lg border border-slate-200 p-4">
              {chatMessages.length === 0 && (
                <p className="text-sm text-slate-500">Start the microphone and speak to create a local transcript and draft.</p>
              )}
              {chatMessages.map((message, index) => (
                <article
                  key={`voice-${index}-${message.role}`}
                  className={`rounded-lg p-3 text-sm ${message.role === 'user' ? 'bg-blue-50' : 'bg-amber-50'}`}
                >
                  <p className="font-semibold">{message.role === 'user' ? 'Recognized transcript' : 'AI draft'}</p>
                  <p className="mt-1 whitespace-pre-wrap">{message.content}</p>
                  {Number.isFinite(message.transcriptToDraftMs) && (
                    <p className="mt-1 text-xs text-slate-500">
                      Draft returned in {(message.transcriptToDraftMs / 1000).toFixed(1)} s after transcript receipt.
                    </p>
                  )}
                  {message.role === 'assistant' && (
                    <div className="mt-3 flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={() => void prepareSpokenDraft(index, message.content)}
                        disabled={isPreparingSpeechIndex !== null}
                        className="rounded-lg border border-blue-300 px-3 py-1.5 text-xs font-semibold text-blue-800 disabled:opacity-50"
                      >
                        {isPreparingSpeechIndex === index ? 'Creating speech…' : 'Prepare spoken reply'}
                      </button>
                      {draftOutput === 'g1' && g1AudioConnected && (
                        <button
                          type="button"
                          onClick={() => void speakDraftOnG1(message.content)}
                          disabled={
                            isSendingG1Speech
                            || !message.content.trim()
                            || message.content.length > MAX_G1_SPEECH_PREVIEW_CHARS
                          }
                          className="rounded-lg border border-emerald-300 px-3 py-1.5 text-xs font-semibold text-emerald-800 disabled:opacity-50"
                        >
                          {isSendingG1Speech ? 'Sending to G1…' : 'Speak this draft on G1'}
                        </button>
                      )}
                      {draftOutput === 'g1' && g1AudioConnected
                        && message.content.length > MAX_G1_SPEECH_PREVIEW_CHARS && (
                          <span className="self-center text-xs text-slate-600">
                            Shorten this draft to 120 characters before sending it to the G1.
                          </span>
                      )}
                    </div>
                  )}
                  {message.speechUrl && (
                    <audio
                      controls
                      src={message.speechUrl}
                      className="mt-3 w-full"
                      aria-label={`Spoken draft ${index + 1}`}
                      onPlay={(event) => {
                        if (speechAudioRef.current && speechAudioRef.current !== event.currentTarget) {
                          speechAudioRef.current.pause();
                          speechAudioRef.current.currentTime = 0;
                        }
                        speechAudioRef.current = event.currentTarget;
                        setPlayingSpeechIndex(index);
                      }}
                      onPause={() => setPlayingSpeechIndex((current) => current === index ? null : current)}
                      onEnded={() => setPlayingSpeechIndex((current) => current === index ? null : current)}
                    />
                  )}
                </article>
              ))}
              {chatError && <p role="alert" className="text-sm text-red-700">{chatError}</p>}
              {isGeneratingDraft && <p role="status" className="text-sm text-slate-600">Generating a local draft…</p>}
              {playingSpeechIndex !== null && (
                <button
                  type="button"
                  onClick={stopSpeechPlayback}
                  className="rounded-lg border border-rose-300 px-3 py-1.5 text-xs font-semibold text-rose-700"
                >
                  Stop spoken reply
                </button>
              )}
            </div>
          </section>
        )}

        {previewMode === 'text' && (
          <>
            <section className="grid gap-6 md:grid-cols-2">
              <div className="space-y-4 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h2 className="text-lg font-semibold">Agent profiles</h2>
                    <p className="mt-1 text-sm text-slate-600">
                      Saved profiles are shared across teacher accounts. Safety and stage rules stay fixed.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={startNewAgent}
                    className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-semibold hover:bg-slate-50"
                  >
                    New agent
                  </button>
                </div>
                <label className="block text-sm font-medium">
                  Agent for this chat
                  <select
                    value={selectedAgentId}
                    onChange={selectAgent}
                    disabled={isLoadingConfig}
                    className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2"
                  >
                    {selectedAgentId === '__new__' && <option value="__new__">New custom agent</option>}
                    {agents.map((agent) => (
                      <option key={agent.agent_id} value={agent.agent_id}>{agent.display_name}</option>
                    ))}
                  </select>
                </label>
                <form onSubmit={saveAgent} className="space-y-3">
                  <label className="block text-sm font-medium">
                    Name
                    <input
                      required
                      maxLength={80}
                      value={agentDraft?.display_name || ''}
                      onChange={(event) => updateAgentDraft('display_name', event.target.value)}
                      className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
                      disabled={isLoadingConfig}
                    />
                  </label>
                  <label className="block text-sm font-medium">
                    Purpose
                    <textarea
                      required
                      maxLength={500}
                      rows={2}
                      value={agentDraft?.purpose || ''}
                      onChange={(event) => updateAgentDraft('purpose', event.target.value)}
                      className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
                      disabled={isLoadingConfig}
                    />
                  </label>
                  <label className="block text-sm font-medium">
                    Additional role instructions
                    <textarea
                      required
                      maxLength={5000}
                      rows={4}
                      value={agentDraft?.instructions || ''}
                      onChange={(event) => updateAgentDraft('instructions', event.target.value)}
                      className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
                      disabled={isLoadingConfig}
                    />
                  </label>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <label className="block text-sm font-medium">
                      Temperature
                      <input
                        type="number"
                        min="0"
                        max="1"
                        step="0.1"
                        value={agentDraft?.generation_temperature ?? 0.4}
                        onChange={(event) => updateAgentDraft('generation_temperature', event.target.value)}
                        className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
                        disabled={isLoadingConfig}
                      />
                    </label>
                    <label className="block text-sm font-medium">
                      Maximum response tokens
                      <input
                        type="number"
                        min="64"
                        max="1000"
                        step="1"
                        value={agentDraft?.generation_max_tokens ?? 500}
                        onChange={(event) => updateAgentDraft('generation_max_tokens', event.target.value)}
                        className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
                        disabled={isLoadingConfig}
                      />
                    </label>
                  </div>
                  <div className="flex flex-wrap gap-3">
                    <button
                      type="submit"
                      disabled={isSavingAgent || isLoadingConfig}
                      className="rounded-lg bg-blue-700 px-4 py-2 font-semibold text-white hover:bg-blue-800 disabled:opacity-50"
                    >
                      {isSavingAgent ? 'Saving…' : 'Save agent'}
                    </button>
                    {agentDraft?.agent_id && !agentDraft.is_builtin && (
                      <button
                        type="button"
                        onClick={() => void deleteAgent()}
                        className="rounded-lg border border-rose-300 px-4 py-2 font-semibold text-rose-700 hover:bg-rose-50"
                      >
                        Delete agent
                      </button>
                    )}
                  </div>
                </form>
                {configError && <p role="alert" className="text-sm text-red-700">{configError}</p>}
                {isLoadingConfig && <p role="status" className="text-sm text-slate-600">Loading shared settings…</p>}
                {knowledgeStatus && <p role="status" className="text-sm text-emerald-700">{knowledgeStatus}</p>}
                <p className="rounded-lg bg-amber-50 p-3 text-xs leading-relaxed text-amber-950">
                  Agent instructions can specialize learning tasks but cannot replace the common safety policy. All profiles currently use the same configured local model; model-provider switching is not enabled.
                </p>
              </div>

              <div className="space-y-4 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
                <div>
                  <h2 className="text-lg font-semibold">Conversation setup</h2>
                  <p className="mt-1 text-sm text-slate-600">Choose a stage and tone for the next text draft.</p>
                </div>
                <label className="block text-sm font-medium">
                  IB programme / year
                  <select
                    value={learningLevel}
                    onChange={(event) => setLearningLevel(event.target.value)}
                    className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2"
                  >
                    <option value="">Choose before substantive answers</option>
                    {LEARNING_LEVELS.map((level) => <option key={level} value={level}>{level}</option>)}
                  </select>
                </label>
                <label className="block text-sm font-medium">
                  Tone
                  <select
                    value={tone}
                    onChange={(event) => setTone(event.target.value)}
                    className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2"
                  >
                    <option>Formal</option>
                    <option>Lightly humorous</option>
                  </select>
                </label>
                <p className="rounded-lg bg-blue-50 p-3 text-sm text-blue-900">
                  Chat is teacher-preview only. Typed text and recent in-page history go to the configured local model. Voice turns use local transcription; no audio is retained.
                </p>
              </div>
            </section>

            <section className="space-y-5 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
              <div>
                <h2 className="text-lg font-semibold">Local knowledge library</h2>
                <p className="mt-1 text-sm text-slate-600">
                  Add approved references for all agents or scope a document to one agent and IB stage.
                </p>
              </div>
              <p className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">
                Only upload material you have permission to use. Do not upload student records, identifiable learner data, confidential school records, or sensitive personal information. Documents are stored in the local app database and shared with every teacher account.
              </p>
              <form onSubmit={uploadKnowledge} className="grid gap-3 md:grid-cols-2">
                <label className="block text-sm font-medium md:col-span-2">
                  {editingKnowledgeId ? 'Replace with a plain-text file (optional, .txt or .md, up to 100 KB)' : 'Plain-text file (.txt or .md, up to 100 KB)'}
                  <input
                    name="knowledgeFile"
                    type="file"
                    accept=".txt,.md,text/plain,text/markdown"
                    onChange={handleKnowledgeFileChange}
                    required={!editingKnowledgeId}
                    className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2"
                  />
                </label>
                <label className="block text-sm font-medium">
                  Document title
                  <input
                    required
                    maxLength={160}
                    value={knowledgeDraft.title}
                    onChange={(event) => setKnowledgeDraft({ ...knowledgeDraft, title: event.target.value })}
                    className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
                  />
                </label>
                <label className="block text-sm font-medium">
                  Source / citation
                  <input
                    required
                    maxLength={500}
                    value={knowledgeDraft.source}
                    onChange={(event) => setKnowledgeDraft({ ...knowledgeDraft, source: event.target.value })}
                    className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
                    placeholder="Source title, URL, or document reference"
                  />
                </label>
                <label className="block text-sm font-medium">
                  Source owner
                  <input
                    required
                    maxLength={120}
                    value={knowledgeDraft.owner}
                    onChange={(event) => setKnowledgeDraft({ ...knowledgeDraft, owner: event.target.value })}
                    className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
                  />
                </label>
                <label className="block text-sm font-medium">
                  Review date
                  <input
                    type="date"
                    required
                    value={knowledgeDraft.review_date}
                    onChange={(event) => setKnowledgeDraft({ ...knowledgeDraft, review_date: event.target.value })}
                    className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
                  />
                </label>
                <label className="block text-sm font-medium">
                  Stage scope
                  <select
                    value={knowledgeDraft.learning_level}
                    onChange={(event) => setKnowledgeDraft({ ...knowledgeDraft, learning_level: event.target.value })}
                    className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2"
                  >
                    <option value="">All stages</option>
                    {LEARNING_LEVELS.map((level) => <option key={level} value={level}>{level}</option>)}
                  </select>
                </label>
                <label className="block text-sm font-medium">
                  Agent scope
                  <select
                    value={knowledgeDraft.agent_id}
                    onChange={(event) => setKnowledgeDraft({ ...knowledgeDraft, agent_id: event.target.value })}
                    className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2"
                  >
                    <option value="">Shared with all agents</option>
                    {agents.map((agent) => (
                      <option key={agent.agent_id} value={agent.agent_id}>{agent.display_name}</option>
                    ))}
                  </select>
                </label>
                <label className="block text-sm font-medium md:col-span-2">
                  Reference content (up to 100 KB)
                  <textarea
                    required
                    value={knowledgeDraft.text}
                    onChange={(event) => setKnowledgeDraft({ ...knowledgeDraft, text: event.target.value })}
                    rows={8}
                    className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-xs"
                  />
                </label>
                <label className="flex items-start gap-2 text-sm md:col-span-2">
                  <input
                    type="checkbox"
                    checked={knowledgeDraft.permission_confirmed}
                    onChange={(event) => setKnowledgeDraft({
                      ...knowledgeDraft,
                      permission_confirmed: event.target.checked,
                    })}
                    required
                    className="mt-1"
                  />
                  I confirm this material is approved for this use and contains no student-identifiable or confidential data.
                </label>
                {knowledgeError && <p role="alert" className="text-sm text-red-700 md:col-span-2">{knowledgeError}</p>}
                <button
                  type="submit"
                  disabled={isUploadingKnowledge || isReadingKnowledge || isLoadingConfig}
                  className="w-fit rounded-lg bg-blue-700 px-4 py-2 font-semibold text-white hover:bg-blue-800 disabled:opacity-50"
                >
                  {isUploadingKnowledge
                    ? (editingKnowledgeId ? 'Saving changes…' : 'Adding reference…')
                    : (editingKnowledgeId ? 'Update reference' : 'Add to knowledge library')}
                </button>
                {editingKnowledgeId && (
                  <button
                    type="button"
                    onClick={cancelKnowledgeEdit}
                    className="w-fit rounded-lg border border-slate-300 px-4 py-2 font-semibold text-slate-700 hover:bg-slate-50"
                  >
                    Cancel edit
                  </button>
                )}
              </form>
              {knowledgeDocuments.length === 0 ? (
                <p className="text-sm text-slate-500">No approved references have been added.</p>
              ) : (
                <ul className="space-y-3">
                  {knowledgeDocuments.map((document) => {
                    const agent = agents.find((item) => item.agent_id === document.agent_id);
                    return (
                      <li key={document.document_id} className="flex flex-wrap items-start justify-between gap-3 rounded-lg border border-slate-200 p-3">
                        <div className="min-w-0">
                          <p className="font-semibold">{document.title}</p>
                          <p className="break-words text-sm text-slate-600">
                            {document.source} · Owner: {document.owner}
                          </p>
                          <p className="text-xs text-slate-500">
                            {document.learning_level || 'All stages'} · {agent?.display_name || 'All agents'}
                            {document.review_date < new Date().toISOString().slice(0, 10)
                              ? ` · REVIEW REQUIRED (reviewed ${document.review_date})`
                              : ` · Review by ${document.review_date}`}
                          </p>
                        </div>
                        <div className="flex gap-2">
                          <button
                            type="button"
                            onClick={() => void editKnowledge(document.document_id)}
                            className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-semibold text-slate-700 hover:bg-slate-50"
                          >
                            Edit
                          </button>
                          <button
                            type="button"
                            onClick={() => void deleteKnowledge(document.document_id)}
                            className="rounded-lg border border-rose-300 px-3 py-1.5 text-sm font-semibold text-rose-700 hover:bg-rose-50"
                          >
                            Delete
                          </button>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          </>
        )}

      </div>
    </main>
  );
}
