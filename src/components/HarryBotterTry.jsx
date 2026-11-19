import { useCallback, useEffect, useRef, useState } from 'react';
import { compileG1VoiceBlockProgram } from '../sim/g1Commands.js';

const SESSION_STORAGE_KEY = 'edu-classroom-session';
const MAX_KNOWLEDGE_BYTES = 100_000;
const MAX_G1_SPEECH_PREVIEW_CHARS = 120;
const TONE_OPTIONS = [
  'Formal',
  'Lightly humorous',
  'Warm and encouraging',
  'Curious/Socratic',
  'Concise',
];
const TTS_VOICE_LABELS = {
  af_heart: 'American English - af_heart',
  af_bella: 'American English - af_bella',
  af_nicole: 'American English - af_nicole',
  am_michael: 'American English male - am_michael',
  bm_fable: 'British English male - bm_fable',
  bm_george: 'British English male - bm_george',
  qwen3_youthful_south_london: 'Experimental youthful South London - Qwen3 VoiceDesign',
};
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

function getStoredTeacherSession() {
  try {
    const storedSession = localStorage.getItem(SESSION_STORAGE_KEY);
    if (!storedSession) return null;

    let session;
    try {
      session = JSON.parse(storedSession);
    } catch {
      localStorage.removeItem(SESSION_STORAGE_KEY);
      return null;
    }
    if (typeof session?.token === 'string' && session.token && session.user?.role === 'teacher') {
      return session;
    }
    localStorage.removeItem(SESSION_STORAGE_KEY);
  } catch {
    return null;
  }
  return null;
}

export default function HarryBotterTry() {
  const [credentials, setCredentials] = useState({ username: '', password: '' });
  const [loginError, setLoginError] = useState('');
  const [isLoggingIn, setIsLoggingIn] = useState(false);
  const [teacherSession, setTeacherSession] = useState(getStoredTeacherSession);
  const [learningLevel, setLearningLevel] = useState('');
  const [tone, setTone] = useState('Formal');
  const [speechSpeed, setSpeechSpeed] = useState(1);
  const [ttsVoice, setTtsVoice] = useState('');
  const [voiceCandidate, setVoiceCandidate] = useState('');
  const [voicePreviewUrl, setVoicePreviewUrl] = useState('');
  const [voicePreviewedId, setVoicePreviewedId] = useState('');
  const [hasPlayedVoicePreview, setHasPlayedVoicePreview] = useState(false);
  const [voicePreviewError, setVoicePreviewError] = useState('');
  const [isGeneratingVoicePreview, setIsGeneratingVoicePreview] = useState(false);
  const [previewMode, setPreviewMode] = useState('text');
  const [agents, setAgents] = useState([]);
  const [behaviorSections, setBehaviorSections] = useState([]);
  const [behaviorSectionDraft, setBehaviorSectionDraft] = useState({
    section_id: 'persona',
    guidance: '',
  });
  const [policyReviewDocumentIds, setPolicyReviewDocumentIds] = useState([]);
  const [policyReviewProposal, setPolicyReviewProposal] = useState(null);
  const [policyReviewError, setPolicyReviewError] = useState('');
  const [isReviewingPolicySources, setIsReviewingPolicySources] = useState(false);
  const [sectionApprovalConfirmed, setSectionApprovalConfirmed] = useState(false);
  const [isSavingBehaviorSection, setIsSavingBehaviorSection] = useState(false);
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
    intended_use: '',
    section_id: 'general',
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
  const [modelSelection, setModelSelection] = useState('');
  const [isSelectingModel, setIsSelectingModel] = useState(false);
  const [modelSelectionError, setModelSelectionError] = useState('');
  const [speechStatus, setSpeechStatus] = useState(null);
  const [g1RobotStatus, setG1RobotStatus] = useState(null);
  const [draftOutput, setDraftOutput] = useState('browser');
  const [g1SpeakerId, setG1SpeakerId] = useState('0');
  const [isSendingG1Speech, setIsSendingG1Speech] = useState(false);
  const [g1SpeechStatus, setG1SpeechStatus] = useState('');
  const [g1SpeechError, setG1SpeechError] = useState('');
  const [chatText, setChatText] = useState('');
  const [chatMessages, setChatMessages] = useState([]);
  const [plannerTopic, setPlannerTopic] = useState('');
  const [plannerObjective, setPlannerObjective] = useState('');
  const [plannerDuration, setPlannerDuration] = useState('30');
  const [plannerMaterials, setPlannerMaterials] = useState('');
  const [teacherSessions, setTeacherSessions] = useState([]);
  const [selectedSessionId, setSelectedSessionId] = useState('');
  const [isLoadingSessions, setIsLoadingSessions] = useState(false);
  const [isChangingSession, setIsChangingSession] = useState(false);
  const [sessionError, setSessionError] = useState('');
  const [safeguardingAlerts, setSafeguardingAlerts] = useState([]);
  const [safeguardingAlertError, setSafeguardingAlertError] = useState('');
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
  const conversationSettingsRef = useRef({ learningLevel, tone, selectedAgentId });
  const recorderRef = useRef(null);
  const speechRequestRef = useRef(null);
  const speechAudioRef = useRef(null);
  const streamRef = useRef(null);
  const audioChunksRef = useRef([]);
  const audioElementRef = useRef(null);
  const voicePreviewUrlRef = useRef('');
  const recordingUrlRef = useRef('');
  const recordingTimerRef = useRef(null);
  const draftRequestRef = useRef(null);
  const speechUrlsRef = useRef(new Set());
  const voiceSessionRef = useRef(null);
  const voiceStartupCancelledRef = useRef(false);
  const voiceTranscriptQueueRef = useRef([]);
  const voiceTranscriptProcessingRef = useRef(false);
  const chatMessagesRef = useRef(chatMessages);
  const selectedSessionIdRef = useRef(selectedSessionId);
  const isGeneratingDraftRef = useRef(isGeneratingDraft);
  const activeTtsVoice = ttsVoice || speechStatus?.speech_generation?.voice || 'af_heart';
  const g1AudioConnected = g1RobotStatus?.capabilities?.audio === true;
  const selectedBehaviorSection = behaviorSections.find(
    (section) => section.section_id === behaviorSectionDraft.section_id,
  );
  const eligiblePolicyDocuments = knowledgeDocuments.filter((document) => (
    document.permission_confirmed_at
    && (!document.review_date || document.review_date >= new Date().toISOString().slice(0, 10))
    && ['general', behaviorSectionDraft.section_id].includes(document.section_id)
    && (!document.learning_level || (learningLevel && document.learning_level === learningLevel))
    && (!document.agent_id || document.agent_id === selectedAgentId)
  ));
  chatMessagesRef.current = chatMessages;
  selectedSessionIdRef.current = selectedSessionId;
  isGeneratingDraftRef.current = isGeneratingDraft;
  conversationSettingsRef.current = {
    learningLevel,
    tone,
    selectedAgentId,
    agentName: agents.find((agent) => agent.agent_id === selectedAgentId)?.display_name || selectedAgentId,
  };

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
    if (voicePreviewUrlRef.current) URL.revokeObjectURL(voicePreviewUrlRef.current);
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

  useEffect(() => {
    const agent = agents.find((item) => item.agent_id === selectedAgentId);
    if (!agent) return;
    setTtsVoice(agent.tts_voice || speechStatus?.speech_generation?.voice || 'af_heart');
    setSpeechSpeed(agent.tts_speed ?? 1);
  }, [agents, selectedAgentId, speechStatus]);

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
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetch('/api/harry-botter/model-status', {
        headers: { Authorization: `Bearer ${session.token}` },
        signal: controller.signal,
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.detail || 'Could not check the configured model route.');
      setModelStatus(result);
    } catch (error) {
      setModelStatus({
        status: 'service_unavailable',
        error: error.name === 'AbortError'
          ? 'Timed out waiting for the local AI service. Check the startup output and retry.'
          : error.message,
      });
    } finally {
      window.clearTimeout(timeoutId);
      setIsCheckingModel(false);
    }
  }, [teacherSession]);

  const selectLocalModel = async () => {
    if (!teacherSession?.token || !modelSelection || isSelectingModel) return;
    let selection;
    try {
      selection = JSON.parse(modelSelection);
    } catch {
      setModelSelectionError('Choose a model from the available list.');
      return;
    }
    setModelSelectionError('');
    setIsSelectingModel(true);
    try {
      const response = await fetch('/api/harry-botter/model-select', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${teacherSession.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(selection),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.detail || 'Could not select that model.');
      setModelStatus(result);
      setModelSelection(JSON.stringify({ route: result.route, model: result.model }));
    } catch (error) {
      setModelSelectionError(error.message || 'Could not select that model.');
    } finally {
      setIsSelectingModel(false);
    }
  };

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
      const sections = Array.isArray(result.sections) ? result.sections : [];
      setBehaviorSections(sections);
      setBehaviorSectionDraft((current) => {
        const selected = sections.find((section) => section.section_id === current.section_id)
          || sections[0];
        return selected
          ? { section_id: selected.section_id, guidance: selected.guidance }
          : current;
      });
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

  const loadConversation = useCallback(async (sessionId, authSession = teacherSession) => {
    const response = await fetch(`/api/harry-botter/sessions/${sessionId}`, {
      headers: { Authorization: `Bearer ${authSession.token}` },
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.detail || 'Could not load the saved conversation.');
    if (result.session?.session_id !== sessionId || !Array.isArray(result.session.messages)) {
      throw new Error('The saved conversation response was incomplete.');
    }
    stopSpeechPlayback();
    setEditingDraftIndex(null);
    setEditedDraftText('');
    const messages = result.session.messages.map((message) => ({
      ...message,
      messageId: message.messageId || crypto.randomUUID(),
      messageSource: message.messageSource || (
        message.role === 'assistant' ? 'generated_draft' : 'typed'
      ),
    }));
    setChatMessages(messages);
    chatMessagesRef.current = messages;
    setSelectedSessionId(sessionId);
    selectedSessionIdRef.current = sessionId;
    const settings = result.session.settings;
    if (settings) {
      setLearningLevel(settings.learning_level || '');
      setTone(settings.tone || 'Formal');
      setSelectedAgentId(settings.agent_id || 'general');
    }
    setChatError('');
    setSessionError('');
  }, [teacherSession]);

  const loadConversationSessions = useCallback(async (authSession = teacherSession) => {
    if (!authSession?.token) return;
    setIsLoadingSessions(true);
    setSessionError('');
    try {
      const response = await fetch('/api/harry-botter/sessions', {
        headers: { Authorization: `Bearer ${authSession.token}` },
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.detail || 'Could not load saved conversations.');
      if (!Array.isArray(result.sessions)) {
        throw new Error('The saved conversation list was incomplete.');
      }
      let sessions = result.sessions;
      if (sessions.length === 0) {
        const createResponse = await fetch('/api/harry-botter/sessions', {
          method: 'POST',
          headers: { Authorization: `Bearer ${authSession.token}` },
        });
        const created = await createResponse.json();
        if (!createResponse.ok) {
          throw new Error(created.detail || 'Could not create a conversation.');
        }
        if (!created.session?.session_id) {
          throw new Error('The conversation service returned an invalid session.');
        }
        sessions = [created.session];
      }
      setTeacherSessions(sessions);
      await loadConversation(sessions[0].session_id, authSession);
    } catch (error) {
      setSessionError(error.message || 'Could not load saved conversations.');
    } finally {
      setIsLoadingSessions(false);
    }
  }, [loadConversation, teacherSession]);

  const saveConversationMessages = useCallback(async (
    sessionId,
    messages,
    authSession = teacherSession,
  ) => {
    if (!sessionId || !authSession?.token) return false;
    try {
      const serializedMessages = messages.map((message) => ({
        messageId: message.messageId,
        role: message.role,
        content: message.content,
        messageSource: message.messageSource || (
          message.role === 'assistant' ? 'generated_draft' : 'typed'
        ),
        speakerLabel: message.speakerLabel || null,
        confidence: message.confidence ?? null,
        createdAt: message.createdAt || null,
        model: message.model || '',
        route: message.route || '',
        source: message.source || '',
        sources: message.sources || [],
        settings: message.settings || null,
        transcriptToDraftMs: message.transcriptToDraftMs ?? null,
        speechVoice: message.speechVoice || '',
        speechSpeed: message.speechSpeed ?? null,
        draftStatus: message.draftStatus || 'draft',
      }));
      const response = await fetch(`/api/harry-botter/sessions/${sessionId}/messages`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${authSession.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ messages: serializedMessages }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.detail || 'Could not save this conversation.');
      setTeacherSessions((sessions) => sessions.map((item) => (
        item.session_id === sessionId
          ? {
            ...item,
            title: result.session?.title || item.title,
            updated_at: result.session?.updated_at || item.updated_at,
          }
          : item
      )));
      setSessionError('');
      return true;
    } catch (error) {
      setSessionError(`Conversation not saved: ${error.message || 'storage is unavailable.'}`);
      return false;
    }
  }, [teacherSession]);

  const createConversation = async (whileChanging = false) => {
    if (!teacherSession?.token || (isChangingSession && !whileChanging)) return;
    setIsChangingSession(true);
    setSessionError('');
    try {
      const response = await fetch('/api/harry-botter/sessions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${teacherSession.token}` },
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.detail || 'Could not create a conversation.');
      if (!result.session?.session_id) throw new Error('The conversation service returned an invalid session.');
      setTeacherSessions((sessions) => [result.session, ...sessions]);
      await loadConversation(result.session.session_id);
    } catch (error) {
      setSessionError(error.message || 'Could not create a conversation.');
    } finally {
      setIsChangingSession(false);
    }
  };

  const selectConversation = async (sessionId) => {
    if (!sessionId || sessionId === selectedSessionIdRef.current || isChangingSession) return;
    setIsChangingSession(true);
    setSessionError('');
    try {
      await loadConversation(sessionId);
    } catch (error) {
      setSessionError(error.message || 'Could not load the saved conversation.');
    } finally {
      setIsChangingSession(false);
    }
  };

  const deleteConversation = async () => {
    if (!selectedSessionIdRef.current || !teacherSession?.token || isChangingSession) return;
    if (!window.confirm('Delete this saved conversation and its text history? This cannot be undone.')) return;
    setIsChangingSession(true);
    setSessionError('');
    try {
      const deletedId = selectedSessionIdRef.current;
      const response = await fetch(`/api/harry-botter/sessions/${deletedId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${teacherSession.token}` },
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.detail || 'Could not delete the conversation.');
      const remaining = teacherSessions.filter((session) => session.session_id !== deletedId);
      setTeacherSessions(remaining);
      setChatMessages([]);
      chatMessagesRef.current = [];
      setSelectedSessionId('');
      selectedSessionIdRef.current = '';
      if (remaining.length > 0) {
        await loadConversation(remaining[0].session_id);
      } else {
        await createConversation(true);
      }
    } catch (error) {
      setSessionError(error.message || 'Could not delete the conversation.');
    } finally {
      setIsChangingSession(false);
    }
  };

  const refreshSafeguardingAlerts = useCallback(async (authSession = teacherSession) => {
    if (!authSession?.token) return;
    try {
      const response = await fetch('/api/harry-botter/alerts', {
        headers: { Authorization: `Bearer ${authSession.token}` },
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.detail || 'Could not load safeguarding alerts.');
      if (!Array.isArray(result.alerts)) throw new Error('The safeguarding alert response was incomplete.');
      setSafeguardingAlerts(result.alerts);
      setSafeguardingAlertError('');
    } catch (error) {
      setSafeguardingAlertError(error.message || 'Could not load safeguarding alerts.');
    }
  }, [teacherSession]);

  const acknowledgeSafeguardingAlert = async (alertId) => {
    setSafeguardingAlertError('');
    try {
      const response = await fetch(
        `/api/harry-botter/alerts/${encodeURIComponent(alertId)}/acknowledge`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${teacherSession.token}` },
        },
      );
      const result = await response.json();
      if (!response.ok) throw new Error(result.detail || 'Could not mark this alert as reviewed.');
      setSafeguardingAlerts((alerts) => alerts.filter((alert) => alert.alert_id !== alertId));
    } catch (error) {
      setSafeguardingAlertError(error.message || 'Could not mark this alert as reviewed.');
    }
  };

  useEffect(() => {
    if (teacherSession) void checkLocalModel(teacherSession);
  }, [teacherSession, checkLocalModel]);

  useEffect(() => {
    if (modelStatus?.route && modelStatus?.model) {
      setModelSelection(JSON.stringify({
        route: modelStatus.route,
        model: modelStatus.model,
      }));
    }
  }, [modelStatus?.route, modelStatus?.model]);

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

  useEffect(() => {
    if (teacherSession) {
      void loadConversationSessions(teacherSession);
      void refreshSafeguardingAlerts(teacherSession);
    } else {
      setTeacherSessions([]);
      setSelectedSessionId('');
      selectedSessionIdRef.current = '';
      setChatMessages([]);
      chatMessagesRef.current = [];
      setSafeguardingAlerts([]);
      setSafeguardingAlertError('');
    }
  }, [teacherSession, loadConversationSessions, refreshSafeguardingAlerts]);

  useEffect(() => {
    if (!teacherSession) return undefined;
    const timer = window.setInterval(() => {
      void refreshSafeguardingAlerts(teacherSession);
    }, 3_000);
    return () => window.clearInterval(timer);
  }, [teacherSession, refreshSafeguardingAlerts]);

  const speakDraftOnG1 = async (text) => {
    if (isSendingG1Speech || draftOutput !== 'g1' || g1RobotStatus?.capabilities?.audio !== true) return;
    setG1SpeechError('');
    setG1SpeechStatus('');
    setIsSendingG1Speech(true);
    try {
      const response = await fetch('/api/run', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${teacherSession.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          code: compileG1VoiceBlockProgram(text.trim(), Number(g1SpeakerId)),
        }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.detail || 'The G1 voice-block program could not run.');
      setG1SpeechStatus('The compiled robot.say voice block was accepted. Check the G1 speaker.');
    } catch (error) {
      setG1SpeechError(error.message || 'Could not run the G1 voice-block program.');
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
    if (!selectedSessionIdRef.current) {
      setChatError('Load or create a saved conversation before sending a message.');
      return false;
    }
    if (speechRequestRef.current) cancelSpeechGeneration();
    if (replaceMessageIndex === null) stopSpeechPlayback();
    const requestSessionId = selectedSessionIdRef.current;
    const pendingMessages = replaceMessageIndex === null
      ? [...history, {
        messageId: crypto.randomUUID(),
        role: 'user',
        content: text.trim(),
        messageSource: transcriptReceivedAt === null
          ? 'typed'
          : 'streaming_transcription',
        settings: {
          learningLevel: conversationSettingsRef.current.learningLevel,
          tone: conversationSettingsRef.current.tone,
          agentName: conversationSettingsRef.current.agentName,
          agentId: conversationSettingsRef.current.selectedAgentId,
        },
      }]
      : history;
    setChatError('');
    isGeneratingDraftRef.current = true;
    setIsGeneratingDraft(true);
    const controller = new AbortController();
    draftRequestRef.current = controller;
    try {
      if (replaceMessageIndex === null) {
        setChatMessages(pendingMessages);
        chatMessagesRef.current = pendingMessages;
        setChatText('');
        const saved = await saveConversationMessages(requestSessionId, pendingMessages);
        if (!saved) {
          setChatError('The message was not sent because it could not be saved to this conversation.');
          return false;
        }
      }
      const currentSettings = conversationSettingsRef.current;
      const response = await fetch('/api/harry-botter/draft', {
        method: 'POST',
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${teacherSession.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          text: text.trim(),
          session_id: requestSessionId || null,
          learning_level: currentSettings.learningLevel,
          tone: currentSettings.tone,
          agent_id: currentSettings.selectedAgentId,
          history: history.slice(-12).map(({ role, content }) => ({ role, content })),
        }),
      });
      const result = await response.json();
      if (controller.signal.aborted) return;
      if (!response.ok) throw new Error(result.detail || 'The configured model could not create a draft.');
      if (Array.isArray(result.safeguarding_alerts) && result.safeguarding_alerts.length > 0) {
        setSafeguardingAlerts((alerts) => [
          ...result.safeguarding_alerts.filter(
            (created) => !alerts.some((alert) => alert.alert_id === created.alert_id),
          ),
          ...alerts,
        ]);
      }
      if (!result.draft?.text) throw new Error('The configured model returned an empty draft.');
      const newDraft = {
          messageId: crypto.randomUUID(),
          role: 'assistant',
          content: result.draft.text,
          messageSource: 'generated_draft',
          draftStatus: 'draft',
          model: result.draft.model,
          route: result.draft.route,
          source: result.draft.source,
          sources: result.draft.sources || [],
          settings: {
            learningLevel: currentSettings.learningLevel,
            tone: currentSettings.tone,
            agentName: currentSettings.agentName,
            agentId: currentSettings.selectedAgentId,
          },
          transcriptToDraftMs: transcriptReceivedAt === null
            ? null
            : Math.round(performance.now() - transcriptReceivedAt),
      };
      const nextMessages = replaceMessageIndex === null
        ? [...pendingMessages, newDraft]
        : history.map((message, index) => (
          index === replaceMessageIndex ? newDraft : message
        ));
      if (replaceMessageIndex !== null && playingSpeechIndex === replaceMessageIndex) {
        stopSpeechPlayback();
      }
      setChatMessages(nextMessages);
      chatMessagesRef.current = nextMessages;
      await saveConversationMessages(requestSessionId, nextMessages);
      return true;
    } catch (error) {
      if (error.name !== 'AbortError') {
        setChatError(error.message || 'The configured model could not create a draft.');
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
      if (!voiceStartupCancelledRef.current && voiceTranscriptQueueRef.current.length === 0) {
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
    if (!selectedSessionIdRef.current) {
      setVoiceError('Load or create a saved conversation before starting voice mode.');
      return;
    }
    setVoiceError('');
    setShowMicrophonePermissionHelp(false);
    const AudioContextType = window.AudioContext || window.webkitAudioContext;
    if (!navigator.mediaDevices?.getUserMedia || !AudioContextType || !window.AudioWorkletNode) {
      setVoiceError('This browser does not support live microphone streaming. Use a current browser in a secure context.');
      return;
    }
    if (!speechStatus?.streaming_transcription?.available) {
      const missingPackages = speechStatus?.streaming_transcription?.missing_dependencies || [];
      setVoiceError(
        speechStatus?.error
          ? 'The local AI service is unavailable. Run npm start from the project root and check its startup output.'
          : `Local streaming transcription is unavailable${missingPackages.length ? `; missing packages: ${missingPackages.join(', ')}` : ''}. Follow the audio setup instructions in the voice-service README, then restart with npm start.`,
      );
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
        sessionId: selectedSessionIdRef.current || crypto.randomUUID(),
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

  const clearVoicePreview = () => {
    if (voicePreviewUrlRef.current) {
      URL.revokeObjectURL(voicePreviewUrlRef.current);
      voicePreviewUrlRef.current = '';
    }
    setVoicePreviewUrl('');
    setVoicePreviewedId('');
    setHasPlayedVoicePreview(false);
  };

  const invalidatePreparedSpeech = () => {
    speechAudioRef.current?.pause();
    setPlayingSpeechIndex(null);
    const messages = chatMessagesRef.current.map((message) => {
      if (!message.speechUrl) return message;
      const updatedMessage = { ...message };
      delete updatedMessage.speechUrl;
      return updatedMessage;
    });
    setChatMessages(messages);
    chatMessagesRef.current = messages;
  };

  const persistAgentVoiceSettings = async (voice, speed) => {
    const response = await fetch(
      `/api/harry-botter/agents/${encodeURIComponent(selectedAgentId)}/voice-settings`,
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${teacherSession.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ voice, speed }),
      },
    );
    const result = await response.json();
    if (!response.ok) {
      throw new Error(result.detail || "Could not save this agent's speech settings.");
    }
    setAgents((currentAgents) => currentAgents.map((agent) => (
      agent.agent_id === selectedAgentId ? result.agent : agent
    )));
    setTtsVoice(result.agent.tts_voice);
    setSpeechSpeed(result.agent.tts_speed);
    invalidatePreparedSpeech();
  };

  const applyAuditionedVoice = async () => {
    if (!voicePreviewedId || !hasPlayedVoicePreview) return;
    setVoicePreviewError('');
    try {
      await persistAgentVoiceSettings(voicePreviewedId, speechSpeed);
    } catch (error) {
      setVoicePreviewError(error.message || "Could not save this agent's speech settings.");
    }
  };

  const updateSpeechSpeed = async (speed) => {
    setSpeechSpeed(speed);
    clearVoicePreview();
    setVoicePreviewError('');
    try {
      await persistAgentVoiceSettings(activeTtsVoice, speed);
    } catch (error) {
      setVoicePreviewError(error.message || "Could not save this agent's speech settings.");
    }
  };

  const createVoicePreview = async () => {
    if (isGeneratingVoicePreview) return;
    setVoicePreviewError('');
    setIsGeneratingVoicePreview(true);
    const voice = voiceCandidate || activeTtsVoice;
    try {
      const response = await fetch('/api/harry-botter/speech', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${teacherSession.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          text: 'Hello, I am Harry Botter. What would you like to explore today?',
          speed: speechSpeed,
          voice,
        }),
      });
      if (!response.ok) {
        const result = await response.json();
        throw new Error(result.detail || 'Could not synthesize the selected local voice.');
      }
      const audioBlob = await response.blob();
      if (audioBlob.type !== 'audio/wav') {
        throw new Error('The local speech service returned an unsupported audio type.');
      }
      clearVoicePreview();
      const previewUrl = URL.createObjectURL(audioBlob);
      voicePreviewUrlRef.current = previewUrl;
      setVoicePreviewUrl(previewUrl);
      setVoicePreviewedId(voice);
    } catch (error) {
      setVoicePreviewError(error.message || 'Could not synthesize the selected local voice.');
    } finally {
      setIsGeneratingVoicePreview(false);
    }
  };

  const createActivityPlan = (event) => {
    event.preventDefault();
    const topic = plannerTopic.trim();
    const objective = plannerObjective.trim();
    if (!topic || !objective || !learningLevel || isGeneratingDraft) return;
    const materials = plannerMaterials.trim() || 'Suggest simple, low-cost classroom materials.';
    const prompt = [
      'Create an editable teacher-facing classroom activity plan, not a student answer.',
      `IB stage: ${learningLevel}.`,
      `Topic: ${topic}.`,
      `Learning objective: ${objective}.`,
      `Duration: ${plannerDuration} minutes.`,
      `Available materials or constraints: ${materials}.`,
      'Include a concise sequence with timings, teacher prompts, learner actions, a check for understanding, and an accessible language-support option.',
      'Use age-appropriate content, do not invent school policy or facts, and flag assumptions that the teacher should verify.',
    ].join('\n');
    void requestDraft(prompt, chatMessagesRef.current);
  };

  const regenerateDraft = (draftIndex) => {
    let userIndex = draftIndex - 1;
    while (userIndex >= 0 && chatMessages[userIndex].role !== 'user') userIndex -= 1;
    if (userIndex < 0 || isGeneratingDraft) return;
    const userText = chatMessages[userIndex].content;
    void requestDraft(userText, chatMessages.slice(0, userIndex), draftIndex);
  };

  const saveEditedDraft = async (draftIndex) => {
    const text = editedDraftText.trim();
    if (!text) return;
    if (playingSpeechIndex === draftIndex) stopSpeechPlayback();
    if (isPreparingSpeechIndex === draftIndex) cancelSpeechGeneration();
    const nextMessages = chatMessagesRef.current.map((message, index) => {
      if (index !== draftIndex) return message;
      const updatedMessage = { ...message, content: text, draftStatus: 'edited' };
      delete updatedMessage.speechUrl;
      return updatedMessage;
    });
    setChatMessages(nextMessages);
    chatMessagesRef.current = nextMessages;
    await saveConversationMessages(selectedSessionIdRef.current, nextMessages);
    setEditingDraftIndex(null);
    setEditedDraftText('');
  };

  const dismissDraft = async (draftIndex) => {
    if (playingSpeechIndex === draftIndex) stopSpeechPlayback();
    if (isPreparingSpeechIndex === draftIndex) cancelSpeechGeneration();
    const nextMessages = chatMessagesRef.current.filter((_, index) => index !== draftIndex);
    setChatMessages(nextMessages);
    chatMessagesRef.current = nextMessages;
    await saveConversationMessages(selectedSessionIdRef.current, nextMessages);
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

  const recordCompletedPlayback = async (message, durationSeconds) => {
    const sessionId = selectedSessionIdRef.current;
    if (!sessionId || !message.messageId || !message.speechVoice) return;
    try {
      const response = await fetch(
        `/api/harry-botter/sessions/${sessionId}/playback-events`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${teacherSession.token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            draft_id: message.messageId,
            voice_id: message.speechVoice,
            speed: message.speechSpeed ?? speechSpeed,
            duration_ms: Number.isFinite(durationSeconds)
              ? Math.round(durationSeconds * 1_000)
              : 0,
          }),
        },
      );
      const result = await response.json();
      if (!response.ok) throw new Error(result.detail || 'Could not save playback history.');
    } catch (error) {
      setSpeechError(error.message || 'Could not save playback history.');
    }
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
    const voice = activeTtsVoice;
    const speed = speechSpeed;
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
        body: JSON.stringify({
          text,
          speed,
          voice,
        }),
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
        return {
          ...message,
          speechUrl: nextUrl,
          speechVoice: voice,
          speechSpeed: speed,
        };
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

  const selectBehaviorSection = (sectionId) => {
    const section = behaviorSections.find((item) => item.section_id === sectionId);
    if (!section) return;
    setBehaviorSectionDraft({
      section_id: section.section_id,
      guidance: section.guidance,
    });
    setPolicyReviewDocumentIds([]);
    setPolicyReviewProposal(null);
    setPolicyReviewError('');
    setSectionApprovalConfirmed(false);
  };

  const reviewPolicySources = async () => {
    if (
      isReviewingPolicySources
      || policyReviewDocumentIds.length < 1
      || policyReviewDocumentIds.length > 3
    ) return;
    setPolicyReviewError('');
    setPolicyReviewProposal(null);
    setIsReviewingPolicySources(true);
    try {
      const response = await fetch('/api/harry-botter/policy-review', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${teacherSession.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          section_id: behaviorSectionDraft.section_id,
          document_ids: policyReviewDocumentIds,
          current_guidance: behaviorSectionDraft.guidance,
          learning_level: learningLevel,
          agent_id: selectedAgentId,
        }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.detail || 'Could not review the selected references.');
      if (
        typeof result.proposal?.proposed_guidance !== 'string'
        || !Array.isArray(result.proposal.source_notes)
        || !Array.isArray(result.proposal.conflicts)
        || !Array.isArray(result.proposal.open_questions)
      ) {
        throw new Error('The model returned an incomplete policy review proposal.');
      }
      setPolicyReviewProposal(result);
    } catch (error) {
      setPolicyReviewError(error.message || 'Could not review the selected references.');
    } finally {
      setIsReviewingPolicySources(false);
    }
  };

  const applyPolicyProposal = () => {
    if (!policyReviewProposal?.proposal?.proposed_guidance) return;
    setBehaviorSectionDraft((current) => ({
      ...current,
      guidance: policyReviewProposal.proposal.proposed_guidance,
    }));
    setSectionApprovalConfirmed(false);
    setKnowledgeStatus('Proposal copied into the editor only; review and save it explicitly.');
  };

  const saveBehaviorSection = async (event) => {
    event.preventDefault();
    const section = behaviorSections.find(
      (item) => item.section_id === behaviorSectionDraft.section_id,
    );
    if (!section || isSavingBehaviorSection) return;
    setConfigError('');
    setIsSavingBehaviorSection(true);
    try {
      const response = await fetch(
        `/api/harry-botter/sections/${encodeURIComponent(section.section_id)}`,
        {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${teacherSession.token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            guidance: behaviorSectionDraft.guidance,
            approval_confirmed: sectionApprovalConfirmed,
          }),
        },
      );
      const result = await response.json();
      if (!response.ok) throw new Error(result.detail || 'Could not save this behavior section.');
      setBehaviorSections((current) => current.map((item) => (
        item.section_id === result.section.section_id ? result.section : item
      )));
      setBehaviorSectionDraft({
        section_id: result.section.section_id,
        guidance: result.section.guidance,
      });
      setKnowledgeStatus(`${result.section.title} saved for all teacher accounts.`);
      setSectionApprovalConfirmed(false);
    } catch (error) {
      setConfigError(error.message || 'Could not save this behavior section.');
    } finally {
      setIsSavingBehaviorSection(false);
    }
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
        intended_use: '',
        section_id: 'general',
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
        intended_use: document.intended_use || '',
        section_id: document.section_id || 'general',
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
      intended_use: '',
      section_id: 'general',
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

  const clearConversation = async () => {
    voiceStartupCancelledRef.current = true;
    const hasVoiceSession = Boolean(voiceSessionRef.current);
    if (voiceSessionRef.current) {
      voiceSessionRef.current.suppressTranscriptEvents = true;
    }
    voiceTranscriptQueueRef.current = [];
    draftRequestRef.current?.abort();
    draftRequestRef.current = null;
    isGeneratingDraftRef.current = false;
    setIsGeneratingDraft(false);
    stopVoiceSession('Conversation cleared; voice conversation stopped.');
    if (!hasVoiceSession) setVoiceStatus('Conversation cleared.');
    cancelSpeechGeneration();
    stopSpeechPlayback();
    setChatMessages([]);
    chatMessagesRef.current = [];
    await saveConversationMessages(selectedSessionIdRef.current, []);
    setEditingDraftIndex(null);
    setEditedDraftText('');
    setChatText('');
    setChatError('');
    setVoiceError('');
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
    chatMessagesRef.current = [];
    setTeacherSessions([]);
    setSelectedSessionId('');
    selectedSessionIdRef.current = '';
    setSessionError('');
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
              Configured-model text drafts, transcription, and approved speech playback.
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
          <h2 className="font-semibold">Voice conversations use explicit, visible routes</h2>
          <p className="mt-1">
            In voice mode, the browser sends temporary 16 kHz microphone frames through the teacher-authenticated backend to local voice activity detection and Whisper. Each recognized turn creates a reviewable draft using the configured loopback model or explicitly configured private-network model; no hosted model is used. Spoken replies are synthesized locally and require you to press Play. Speaker diarization is not implemented; voice activity stops explicitly playing browser speech when a new turn begins.
          </p>
          <p className="mt-2">
            Embedded VS Code or Codespaces previews may block microphone access. A webpage cannot open or change browser permission settings, so use a full browser tab to manage this permission.
          </p>
          <p className="mt-2">
            When this app runs in Codespaces, microphone recordings travel to the remote workspace over its authenticated connection. For audio to stay on your own computer, run the app, backend, and speech service from a local checkout.
          </p>
          <p className="mt-2 font-semibold">
            Safeguarding alerts are advisory phrase-pattern signals only. They may miss disclosures or flag ordinary discussion; they do not prove safety or replace the school process. This preview is not approved for student use.
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

        {(safeguardingAlerts.length > 0 || safeguardingAlertError) && (
          <section
            role="alert"
            aria-live="assertive"
            aria-label="Potential safeguarding alerts"
            className="space-y-3 rounded-2xl border border-red-300 bg-red-50 p-5 text-red-950 shadow-sm"
          >
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="font-bold">Potential safeguarding signal — human review required</h2>
                <p className="mt-1 text-sm">
                  These limited phrase patterns are not a complete detector. Follow the school’s safeguarding process; do not rely on the app alone.
                </p>
              </div>
              <button
                type="button"
                onClick={() => void refreshSafeguardingAlerts()}
                className="rounded-lg border border-red-400 px-3 py-2 text-sm font-semibold hover:bg-red-100"
              >
                Refresh alerts
              </button>
            </div>
            {safeguardingAlertError && (
              <p role="status" className="text-sm">{safeguardingAlertError}</p>
            )}
            {safeguardingAlerts.map((alert) => (
              <div
                key={alert.alert_id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-red-200 bg-white p-3"
              >
                <p className="text-sm">
                  {alert.category.replaceAll('_', ' ')} · {alert.session_title || 'Saved conversation'}
                </p>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => void selectConversation(alert.session_id)}
                    disabled={isChangingSession || isGeneratingDraft}
                    className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-semibold text-slate-800 hover:bg-slate-50 disabled:opacity-60"
                  >
                    Review conversation
                  </button>
                  <button
                    type="button"
                    onClick={() => void acknowledgeSafeguardingAlert(alert.alert_id)}
                    className="rounded-lg border border-red-300 px-3 py-1.5 text-sm font-semibold hover:bg-red-100"
                  >
                    Mark reviewed
                  </button>
                </div>
              </div>
            ))}
          </section>
        )}

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
              onChange={(event) => void updateSpeechSpeed(Number(event.target.value))}
              disabled={isGeneratingVoicePreview}
              className="rounded-lg border border-slate-300 bg-white px-3 py-2"
            >
              <option value={0.85}>Slower</option>
              <option value={1}>Normal</option>
              <option value={1.15}>Faster</option>
            </select>
          </label>
          <div
            data-testid="current-browser-voice"
            className="flex items-center gap-2 text-sm font-medium text-slate-700"
          >
            Current browser voice: {ttsVoice || speechStatus?.speech_generation?.voice || 'af_heart'}
          </div>
          <label className="flex items-center gap-2 text-sm font-medium text-slate-700">
            Voice to audition
            <select
              aria-label="Voice to audition"
              value={voiceCandidate}
              onChange={(event) => {
                setVoiceCandidate(event.target.value);
                clearVoicePreview();
                setVoicePreviewError('');
              }}
              disabled={isGeneratingVoicePreview}
              className="max-w-56 rounded-lg border border-slate-300 bg-white px-3 py-2"
            >
              <option value="">
                Configured default ({speechStatus?.speech_generation?.voice || 'af_heart'})
              </option>
              {(speechStatus?.speech_generation?.available_voices || [])
                .filter((voice) => voice !== (speechStatus?.speech_generation?.voice || 'af_heart'))
                .map((voice) => (
                  <option key={voice} value={voice}>
                    {TTS_VOICE_LABELS[voice] || voice}
                  </option>
                ))}
            </select>
          </label>
          <button
            type="button"
            onClick={() => void createVoicePreview()}
            disabled={
              isGeneratingVoicePreview
              || speechStatus?.speech_generation?.available !== true
            }
            className="rounded-lg border border-blue-300 px-3 py-2 text-sm font-semibold text-blue-800 disabled:opacity-50"
          >
            {isGeneratingVoicePreview ? 'Generating sample…' : 'Preview voice'}
          </button>
          <button
            type="button"
            onClick={() => void applyAuditionedVoice()}
            disabled={!voicePreviewedId || !hasPlayedVoicePreview}
            className="rounded-lg border border-emerald-300 px-3 py-2 text-sm font-semibold text-emerald-800 disabled:opacity-50"
          >
            Use auditioned voice
          </button>
          {voicePreviewUrl && (
            <audio
              aria-label="Generated voice preview"
              controls
              src={voicePreviewUrl}
              onPlay={() => setHasPlayedVoicePreview(true)}
              className="w-full"
            />
          )}
          {voicePreviewError && (
            <p role="alert" className="w-full text-sm text-red-700">{voicePreviewError}</p>
          )}
          <p className="w-full text-xs text-slate-500">
            Audition a local Kokoro preset or the optional Qwen3 VoiceDesign sample and press Play before applying it to future browser replies. Qwen3 attempts a fictional youthful South London voice from text instructions only; age and Fulham-area accent are not guaranteed. Celebrity voice imitation and reference-voice cloning are not offered. This does not change the separate G1 speaker voice; review voice terms before school deployment.
          </p>
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

        <section
          aria-label="Saved teacher conversations"
          className="space-y-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm"
        >
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex min-w-56 flex-1 items-center gap-2 text-sm font-medium text-slate-700">
              Saved conversations
              <select
                aria-label="Saved conversations"
                value={selectedSessionId}
                onChange={(event) => void selectConversation(event.target.value)}
                disabled={
                  isLoadingSessions || isChangingSession || isGeneratingDraft
                  || isVoiceSessionActive || isStartingVoiceSession
                }
                className="min-w-0 flex-1 rounded-lg border border-slate-300 bg-white px-3 py-2"
              >
                {teacherSessions.map((session) => (
                  <option key={session.session_id} value={session.session_id}>
                    {session.title || 'New conversation'}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              onClick={() => void createConversation()}
              disabled={
                isLoadingSessions || isChangingSession || isGeneratingDraft
                || isVoiceSessionActive || isStartingVoiceSession
              }
              className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-semibold hover:bg-slate-50 disabled:opacity-60"
            >
              New conversation
            </button>
            <button
              type="button"
              onClick={() => void deleteConversation()}
              disabled={
                !selectedSessionId || isLoadingSessions || isChangingSession || isGeneratingDraft
                || isVoiceSessionActive || isStartingVoiceSession
              }
              className="rounded-lg border border-red-300 px-3 py-2 text-sm font-semibold text-red-700 hover:bg-red-50 disabled:opacity-60"
            >
              Delete conversation
            </button>
          </div>
          <p className="text-xs text-slate-500">
            Text history is stored in the local app database for this teacher until deleted. Only this teacher account can access it; raw audio is never retained.
          </p>
          {sessionError && <p role="alert" className="text-sm text-red-700">{sessionError}</p>}
        </section>

        {previewMode === 'text' && (
          <>
        <section className="space-y-4 rounded-2xl border border-violet-200 bg-white p-6 shadow-sm">
          <div>
            <h2 className="text-lg font-semibold">Teacher activity planner</h2>
            <p className="mt-1 text-sm text-slate-600">
              Generate an editable activity-plan draft using the selected learning stage, agent, and approved references. Review every assumption before using it.
            </p>
          </div>
          <form onSubmit={createActivityPlan} className="grid gap-3 md:grid-cols-2">
            <label className="block text-sm font-medium">
              Activity topic
              <input
                required
                maxLength={300}
                value={plannerTopic}
                onChange={(event) => setPlannerTopic(event.target.value)}
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
              />
            </label>
            <label className="block text-sm font-medium">
              Learning objective
              <input
                required
                maxLength={400}
                value={plannerObjective}
                onChange={(event) => setPlannerObjective(event.target.value)}
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
              />
            </label>
            <label className="block text-sm font-medium">
              Activity duration
              <select
                value={plannerDuration}
                onChange={(event) => setPlannerDuration(event.target.value)}
                className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2"
              >
                <option value="15">15 minutes</option>
                <option value="30">30 minutes</option>
                <option value="45">45 minutes</option>
                <option value="60">60 minutes</option>
              </select>
            </label>
            <label className="block text-sm font-medium">
              Materials or constraints
              <input
                maxLength={500}
                value={plannerMaterials}
                onChange={(event) => setPlannerMaterials(event.target.value)}
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
              />
            </label>
            <div className="md:col-span-2">
              <button
                type="submit"
                disabled={
                  !plannerTopic.trim() || !plannerObjective.trim() || !learningLevel
                  || !selectedSessionId || isGeneratingDraft
                  || modelStatus?.status !== 'ready'
                }
                className="rounded-lg bg-violet-700 px-4 py-2 font-semibold text-white hover:bg-violet-800 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isGeneratingDraft ? 'Generating draft…' : 'Create activity-plan draft'}
              </button>
              {!learningLevel && (
                <p className="mt-2 text-xs text-slate-500">Select the learning stage in the draft settings before planning.</p>
              )}
            </div>
          </form>
        </section>

        <section className="space-y-4 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold">AI draft chat</h2>
              <p className="mt-1 text-sm text-slate-600">
                Teacher testing mode. Replies remain drafts; create speech and press Play only when you approve it. The configured model route is shown below.
              </p>
            </div>
            <button
              type="button"
              onClick={() => void checkLocalModel()}
              disabled={isCheckingModel}
              className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-semibold hover:bg-slate-50 disabled:opacity-60"
            >
              {isCheckingModel ? 'Checking…' : 'Check model route'}
            </button>
            <button
              type="button"
              onClick={clearConversation}
              disabled={
                chatMessages.length === 0
                && !isGeneratingDraft
                && isPreparingSpeechIndex === null
                && !isVoiceSessionActive
                && !isStartingVoiceSession
              }
              className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-semibold hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Clear chat
            </button>
          </div>
          <div role="status" aria-live="polite" className="rounded-lg bg-slate-100 p-3 text-sm text-slate-700">
            {isCheckingModel && 'Checking the configured model route…'}
            {!isCheckingModel && modelStatus?.status === 'ready'
              && `${modelStatus.route === 'network' ? 'Private-network model' : 'Local model'} ready: ${modelStatus.model}. No hosted model is used.`}
            {!isCheckingModel && modelStatus?.status === 'ready' && modelStatus.fallback
              && ` ${modelStatus.fallback} Using the configured local model instead.`}
            {!isCheckingModel && modelStatus?.status === 'not_configured'
              && (modelStatus?.available_models?.length
                ? 'A model server is responding but no model is selected. Choose an installed model below.'
                : 'No local model is configured or installed. Start a loopback OpenAI-compatible model server, install a model, and select it below.')}
            {!isCheckingModel && modelStatus?.status === 'model_missing'
              && `${modelStatus.route === 'network' ? 'The private-network model server' : 'The local model server'} is running, but model “${modelStatus.model}” is not available there.`}
            {!isCheckingModel && modelStatus?.status === 'unavailable'
              && `The configured model server is unavailable. ${modelStatus.error || 'Check that it is running.'}`}
            {!isCheckingModel && modelStatus?.status === 'service_unavailable'
              && `The local AI service is unavailable. Run npm start from the project root to start the backend and voice service; check its startup output for setup errors. ${modelStatus.error || ''}`}
            {!isCheckingModel && !modelStatus && 'Model status has not been checked.'}
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <label className="min-w-64 flex-1 text-sm font-medium">
              Installed model
              <select
                aria-label="Installed AI model"
                value={modelSelection}
                onChange={(event) => {
                  setModelSelection(event.target.value);
                  setModelSelectionError('');
                }}
                disabled={!modelStatus?.available_models?.length || isSelectingModel}
                className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 disabled:bg-slate-100"
              >
                {!modelStatus?.available_models?.length && (
                  <option value="">No installed models found</option>
                )}
                {(modelStatus?.available_models || []).map((item) => {
                  const value = JSON.stringify({ route: item.route, model: item.model });
                  return (
                    <option key={`${item.route}:${item.model}`} value={value}>
                      {item.route === 'network' ? 'Private Wi-Fi' : 'This computer'} - {item.model}
                    </option>
                  );
                })}
              </select>
            </label>
            <button
              type="button"
              onClick={() => void selectLocalModel()}
              disabled={
                !modelSelection
                || !modelStatus?.available_models?.length
                || isSelectingModel
              }
              className="rounded-lg border border-blue-300 px-3 py-2 text-sm font-semibold text-blue-800 disabled:opacity-50"
            >
              {isSelectingModel ? 'Selecting…' : 'Use selected model'}
            </button>
            {modelSelectionError && (
              <p role="alert" className="w-full text-sm text-red-700">{modelSelectionError}</p>
            )}
            <p className="w-full text-xs text-slate-500">
              Choose a model already installed on the configured local or private Wi-Fi server. Selection applies until the voice service restarts; configure the environment settings to change its startup default.
            </p>
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
                      : `AI draft${message.model ? ` · ${message.model}` : ''}${message.route === 'network' ? ' · private Wi-Fi' : message.route === 'local' ? ' · local' : ''}`}
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
                {message.settings && (
                  <p className="mt-1 text-xs text-slate-500">
                    Draft settings: {message.settings.learningLevel || 'Stage not selected'} · {message.settings.tone} · {message.settings.agentName}
                  </p>
                )}
                {message.sources?.length > 0 && (
                  <p className="mt-2 text-xs text-slate-600">
                    Reference context: {message.sources.map((source) => (
                      `${source.section_title ? `${source.section_title}: ` : ''}${source.title} — ${source.source}${source.review_date ? ` (reviewed ${source.review_date})` : ''}`
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
                {message.speechUrl
                  && message.speechVoice === activeTtsVoice
                  && message.speechSpeed === speechSpeed && (
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
                      aria-label={`Spoken draft ${index + 1} in ${message.speechVoice}`}
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
                      onEnded={(event) => {
                        setPlayingSpeechIndex((current) => current === index ? null : current);
                        void recordCompletedPlayback(message, event.currentTarget.duration);
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
            Messages go through the teacher-authenticated app backend. Text history is saved in this teacher-only local database until deleted; raw audio is never stored. When no programme/year is selected, the service asks for the stage without calling a model. Reference excerpts are selected locally and sent only to the configured loopback model. Audio playback is always prepared on request and requires you to press Play.
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
              {speechStatus?.error && `Local AI service unavailable. Run npm start from the project root and check startup output. ${speechStatus.error}`}
              {speechStatus?.transcription && (
                speechStatus.transcription.available
                  ? `Local transcription model: ${speechStatus.transcription.model} (${speechStatus.transcription.device}).`
                  : `Local transcription dependencies are missing${speechStatus.transcription.missing_dependencies?.length ? `: ${speechStatus.transcription.missing_dependencies.join(', ')}` : ''}. Follow the audio setup instructions in the voice-service README, then restart with npm start.`
              )}
              {speechStatus?.streaming_transcription?.available === false
                && ` Live streaming requires: ${(speechStatus.streaming_transcription.missing_dependencies || []).join(', ') || 'the optional audio packages'}.`}
              {speechStatus?.speech_generation && (
                speechStatus.speech_generation.available
                  ? ` Local TTS is available; voice: ${speechStatus.speech_generation.voice}.`
                  : ` Local speech generation dependencies are missing${speechStatus.speech_generation.missing_dependencies?.length ? `: ${speechStatus.speech_generation.missing_dependencies.join(', ')}` : ''}.`
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
                  {TONE_OPTIONS.map((option) => <option key={option}>{option}</option>)}
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
            <p className="text-xs text-slate-500">
              Stage, tone, and agent changes apply to the next draft. Microphone changes require stopping and restarting the conversation.
            </p>
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
              <button
                type="button"
                onClick={clearConversation}
                disabled={
                  chatMessages.length === 0
                  && !isGeneratingDraft
                  && isPreparingSpeechIndex === null
                  && !isVoiceSessionActive
                  && !isStartingVoiceSession
                }
                className="rounded-lg border border-slate-300 px-4 py-2 font-semibold hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Clear conversation
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
              Microphone frames remain temporary in browser memory and are sent only to the loopback speech service through the authenticated backend. The service uses VAD to segment utterances and clears each segment after transcription. Audio is not stored; transcripts are saved as text in this teacher-only conversation until deleted.
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
                  {message.settings && (
                    <p className="mt-1 text-xs text-slate-500">
                      Draft settings: {message.settings.learningLevel || 'Stage not selected'} · {message.settings.tone} · {message.settings.agentName}
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
                  {message.speechUrl
                    && message.speechVoice === activeTtsVoice
                    && message.speechSpeed === speechSpeed && (
                    <audio
                      controls
                      src={message.speechUrl}
                      className="mt-3 w-full"
                      aria-label={`Spoken draft ${index + 1} in ${message.speechVoice}`}
                      onLoadedMetadata={(event) => {
                        if (typeof event.currentTarget.setSinkId === 'function') {
                          event.currentTarget.setSinkId(speakerId).catch((error) => {
                            setSpeechError(`Could not route speech to the selected speaker: ${error.message}`);
                          });
                        }
                      }}
                      onPlay={(event) => {
                        if (speechAudioRef.current && speechAudioRef.current !== event.currentTarget) {
                          speechAudioRef.current.pause();
                          speechAudioRef.current.currentTime = 0;
                        }
                        speechAudioRef.current = event.currentTarget;
                        setPlayingSpeechIndex(index);
                      }}
                      onPause={() => setPlayingSpeechIndex((current) => current === index ? null : current)}
                      onEnded={(event) => {
                        setPlayingSpeechIndex((current) => current === index ? null : current);
                        void recordCompletedPlayback(message, event.currentTarget.duration);
                      }}
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
                  Agent instructions can specialize learning tasks but cannot replace the common safety policy. All profiles currently use the same configured model route; per-agent model switching is not enabled.
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
                    {TONE_OPTIONS.map((option) => <option key={option}>{option}</option>)}
                  </select>
                </label>
                <p className="rounded-lg bg-blue-50 p-3 text-sm text-blue-900">
                  Chat is teacher-preview only. Typed text and recent in-page history go to the configured loopback or explicitly selected private-network model. Voice turns use local transcription; no audio is retained.
                </p>
              </div>
            </section>

            <section className="space-y-4 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
              <div>
                <h2 className="text-lg font-semibold">Behavior and information sections</h2>
                <p className="mt-1 text-sm text-slate-600">
                  These shared settings are saved in the local app database and included in each next draft. Uploaded references are retrieved as context; they do not train or fine-tune the model.
                </p>
              </div>
              {behaviorSections.length === 0 ? (
                <p role="status" className="text-sm text-slate-600">
                  Behavior sections are unavailable. Reload the shared teacher configuration or check the backend.
                </p>
              ) : (
                <form onSubmit={saveBehaviorSection} className="space-y-3">
                  <label className="block text-sm font-medium">
                    Behavior settings section
                    <select
                      value={behaviorSectionDraft.section_id}
                      onChange={(event) => selectBehaviorSection(event.target.value)}
                      disabled={isLoadingConfig || isSavingBehaviorSection}
                      className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2"
                    >
                      {behaviorSections.map((section) => (
                        <option key={section.section_id} value={section.section_id}>{section.title}</option>
                      ))}
                    </select>
                  </label>
                  {selectedBehaviorSection && (
                    <>
                      <p className="text-sm text-slate-600">{selectedBehaviorSection.description}</p>
                      <label className="block text-sm font-medium">
                        Additional shared guidance
                        <textarea
                          aria-label="Additional shared guidance"
                          maxLength={5000}
                          rows={5}
                          value={behaviorSectionDraft.guidance}
                          onChange={(event) => setBehaviorSectionDraft({
                            ...behaviorSectionDraft,
                            guidance: event.target.value,
                          })}
                          disabled={isSavingBehaviorSection}
                          className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
                        />
                      </label>
                      <fieldset className="space-y-2 rounded-lg border border-slate-200 p-3">
                        <legend className="px-1 text-sm font-semibold">Review approved references</legend>
                        <p className="text-sm text-slate-600">
                          Generate an educator-review proposal from up to three in-scope references. Only the first 2,500 characters of each reference are sent to the configured model. This does not change policy or save guidance.
                        </p>
                        {eligiblePolicyDocuments.length === 0 ? (
                          <p className="text-sm text-slate-500">No current, approved references match this section, stage, and agent.</p>
                        ) : (
                          <div className="space-y-2">
                            {eligiblePolicyDocuments.map((document) => {
                              const checked = policyReviewDocumentIds.includes(document.document_id);
                              return (
                                <label key={document.document_id} className="flex items-start gap-2 text-sm">
                                  <input
                                    type="checkbox"
                                    checked={checked}
                                    disabled={isReviewingPolicySources || (!checked && policyReviewDocumentIds.length >= 3)}
                                    onChange={(event) => {
                                      setPolicyReviewDocumentIds((current) => (
                                        event.target.checked
                                          ? [...current, document.document_id].slice(0, 3)
                                          : current.filter((id) => id !== document.document_id)
                                      ));
                                      setPolicyReviewProposal(null);
                                      setPolicyReviewError('');
                                    }}
                                    className="mt-1"
                                  />
                                  <span>{document.title} — {document.source}</span>
                                </label>
                              );
                            })}
                          </div>
                        )}
                        <button
                          type="button"
                          onClick={() => void reviewPolicySources()}
                          disabled={isReviewingPolicySources || policyReviewDocumentIds.length === 0}
                          className="rounded-lg border border-blue-700 px-3 py-2 text-sm font-semibold text-blue-800 hover:bg-blue-50 disabled:opacity-50"
                        >
                          {isReviewingPolicySources ? 'Preparing proposal…' : 'Generate review proposal'}
                        </button>
                        {policyReviewError && <p role="alert" className="text-sm text-red-700">{policyReviewError}</p>}
                        {policyReviewProposal && (
                          <div className="space-y-3 rounded-lg bg-slate-50 p-3 text-sm">
                            <p className="font-semibold">
                              Proposal only · {policyReviewProposal.model} ({policyReviewProposal.route})
                            </p>
                            <p className="whitespace-pre-wrap">{policyReviewProposal.proposal.proposed_guidance || 'The model proposed no guidance.'}</p>
                            {[
                              ['Source notes', policyReviewProposal.proposal.source_notes],
                              ['Potential conflicts', policyReviewProposal.proposal.conflicts],
                              ['Questions for educator', policyReviewProposal.proposal.open_questions],
                            ].map(([label, items]) => (
                              <div key={label}>
                                <p className="font-semibold">{label}</p>
                                {items.length > 0
                                  ? <ul className="list-disc space-y-1 pl-5">{items.map((item, index) => <li key={`${label}-${index}`}>{item}</li>)}</ul>
                                  : <p className="text-slate-600">None identified by the model; this is not confirmation that none exist.</p>}
                              </div>
                            ))}
                            <div>
                              <p className="font-semibold">References supplied</p>
                              <ul className="list-disc pl-5">
                                {policyReviewProposal.sources.map((source, index) => (
                                  <li key={source.reference_id}>[R{index + 1}] {source.title.replace(/^\[R\d+\]\s*/, '')} — {source.source} · Owner: {source.owner}</li>
                                ))}
                              </ul>
                            </div>
                            <button
                              type="button"
                              onClick={applyPolicyProposal}
                              className="rounded-lg bg-amber-700 px-3 py-2 font-semibold text-white hover:bg-amber-800"
                            >
                              Copy proposal into editor for review
                            </button>
                          </div>
                        )}
                      </fieldset>
                      {selectedBehaviorSection.requires_approval && (
                        <label className="flex items-start gap-2 text-sm text-amber-950">
                          <input
                            type="checkbox"
                            checked={sectionApprovalConfirmed}
                            onChange={(event) => setSectionApprovalConfirmed(event.target.checked)}
                            className="mt-1"
                          />
                          I confirm that any school-specific guidance in this section has been approved for this use.
                        </label>
                      )}
                      <button
                        type="submit"
                        disabled={
                          isSavingBehaviorSection
                          || isLoadingConfig
                          || (selectedBehaviorSection.requires_approval
                            && Boolean(behaviorSectionDraft.guidance.trim())
                            && !sectionApprovalConfirmed)
                        }
                        className="rounded-lg bg-blue-700 px-4 py-2 font-semibold text-white hover:bg-blue-800 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {isSavingBehaviorSection ? 'Saving…' : 'Save shared section'}
                      </button>
                    </>
                  )}
                  {configError && <p role="alert" className="text-sm text-red-700">{configError}</p>}
                  {knowledgeStatus && <p role="status" className="text-sm text-emerald-700">{knowledgeStatus}</p>}
                </form>
              )}
            </section>

            <section className="space-y-5 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
              <div>
                <h2 className="text-lg font-semibold">Local knowledge library</h2>
                <p className="mt-1 text-sm text-slate-600">
                  Add approved references to a behavior section, then optionally scope a document to one agent and IB stage.
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
                  Intended classroom use
                  <input
                    required
                    maxLength={500}
                    value={knowledgeDraft.intended_use}
                    onChange={(event) => setKnowledgeDraft({
                      ...knowledgeDraft,
                      intended_use: event.target.value,
                    })}
                    className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
                    placeholder="What should this reference inform, and for which class context?"
                  />
                </label>
                <label className="block text-sm font-medium">
                  Reference category
                  <select
                    value={knowledgeDraft.section_id}
                    onChange={(event) => setKnowledgeDraft({ ...knowledgeDraft, section_id: event.target.value })}
                    className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2"
                  >
                    <option value="general">General reference</option>
                    {behaviorSections.map((section) => (
                      <option key={section.section_id} value={section.section_id}>{section.title}</option>
                    ))}
                  </select>
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
                            {behaviorSections.find((section) => section.section_id === document.section_id)?.title || 'General reference'}
                            {' · '}{document.learning_level || 'All stages'} · {agent?.display_name || 'All agents'}
                            {document.version ? ` · v${document.version}` : ''}
                            {document.permission_confirmed_at
                              ? ` · Permission confirmed ${document.permission_confirmed_at}`
                              : ' · Permission confirmation unavailable'}
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
