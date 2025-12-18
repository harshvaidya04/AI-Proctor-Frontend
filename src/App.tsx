import { useState, useEffect, useRef } from 'react';
import { Camera, Video, AlertCircle, CheckCircle, XCircle, Play, Square, RefreshCw, Users, Shield, Radio } from 'lucide-react';

const API_BASE_URL = 'http://13.126.69.167';

// Types for better development experience
interface Session {
  session_id: string;
  session_type: string;
}

interface Violation {
  violation_type?: string;
  description?: string;
  details: string;
  timestamp: string;
  confidence?: number;
}

interface SessionStatus {
  frames_processed: number;
  total_violations: number;
  status: string;
}

const App = () => {
  const [activeView, setActiveView] = useState<'home' | 'monitoring'>('home');
  const [sessions, setSessions] = useState<Session[]>([]);
  const [currentSession, setCurrentSession] = useState<Session | null>(null);
  const [violations, setViolations] = useState<Violation[]>([]);
  const [sessionStatus, setSessionStatus] = useState<SessionStatus | null>(null);
  const [violationTypes, setViolationTypes] = useState<Record<string, number> | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);

  useEffect(() => {
    fetchActiveSessions();
    const interval = setInterval(fetchActiveSessions, 5000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (currentSession) {
      fetchSessionStatus();
      fetchViolations();
      fetchViolationTypes();
      setupViolationStream();

      const interval = setInterval(() => {
        fetchSessionStatus();
        fetchViolationTypes();
      }, 3000);

      return () => {
        clearInterval(interval);
        if (eventSourceRef.current) {
          eventSourceRef.current.close();
        }
      };
    }
  }, [currentSession]);

  const fetchActiveSessions = async () => {
    try {
      const response = await fetch(`${API_BASE_URL}/active-sessions`);
      if (!response.ok) throw new Error('Failed to fetch sessions');
      const data = await response.json();
      setSessions(data.sessions || []);
    } catch (err) {
      console.error('Error fetching sessions:', err);
      // Don't set error state here to avoid constant error messages on home screen
    }
  };

  const startSession = async (sessionType: 'video-only' | 'audio-video') => {
    setLoading(true);
    setError(null);
    try {
      console.log('Requesting camera access...');
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 1280 },
          height: { ideal: 720 },
          facingMode: 'user'
        },
        audio: sessionType === 'audio-video'
      });

      console.log('Camera access granted, stream obtained:', stream);
      console.log('Video tracks:', stream.getVideoTracks());
      const videoTrack = stream.getVideoTracks()[0];
      if (videoTrack) {
        console.log('Video track enabled:', videoTrack.enabled);
        console.log('Video track readyState:', videoTrack.readyState);
        console.log('Video track settings:', videoTrack.getSettings());
      }

      streamRef.current = stream;

      const response = await fetch(`${API_BASE_URL}/start-session/${sessionType}`, {
        method: 'POST'
      });

      if (!response.ok) {
        throw new Error(`Server returned ${response.status}`);
      }

      const data = await response.json();

      setCurrentSession({
        session_id: data.session_id,
        session_type: data.session_type
      });

      setActiveView('monitoring');

      // Wait a bit for the view to render, then attach stream
      setTimeout(() => {
        if (videoRef.current && streamRef.current) {
          console.log('📺 Attaching stream to video element');
          videoRef.current.srcObject = streamRef.current;

          videoRef.current.onloadedmetadata = () => {
            console.log('✅ Video metadata loaded:', videoRef.current?.videoWidth, 'x', videoRef.current?.videoHeight);
            if (videoRef.current) {
              videoRef.current.play()
                .then(() => console.log('▶️ Video playing successfully'))
                .catch(err => console.error('❌ Video play error:', err));
            }
          };
        }
      }, 200);

    } catch (err: any) {
      console.error("❌ Start session error:", err);
      setError(`Failed to start session: ${err.message}. Please check connection.`);
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(track => track.stop());
        streamRef.current = null;
      }
    } finally {
      setLoading(false);
    }
  };

  // Handle frame capture and session polling
  useEffect(() => {
    let frameInterval: ReturnType<typeof setInterval>;

    if (activeView === 'monitoring' && currentSession?.session_id) {
      console.log('🔄 Monitoring active: Starting capture and polling loops');
      const sessionId = currentSession.session_id;
      const canvas = document.createElement('canvas');

      // 1. Frame Capture Loop
      frameInterval = setInterval(async () => {
        if (!videoRef.current || videoRef.current.readyState < 2) return;

        canvas.width = videoRef.current.videoWidth;
        canvas.height = videoRef.current.videoHeight;
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.drawImage(videoRef.current, 0, 0);
          canvas.toBlob(async (blob) => {
            if (!blob) return;
            const formData = new FormData();
            formData.append('frame', blob, 'frame.jpg');

            try {
              const response = await fetch(`${API_BASE_URL}/process-frame/${sessionId}`, {
                method: 'POST',
                body: formData
              });
              if (!response.ok) {
                const errData = await response.json();
                console.error('❌ Process frame error:', errData);
              }
            } catch (err) {
              console.error('❌ Network error processing frame:', err);
            }
          }, 'image/jpeg', 0.8);
        }
      }, 1000);

      // 2. Initial status fetch
      fetchSessionStatus();
      fetchViolations();
    }

    return () => {
      if (frameInterval) {
        console.log('🛑 Stopping capture loop');
        clearInterval(frameInterval);
      }
    };
  }, [activeView, currentSession?.session_id]);

  const stopSession = async () => {
    if (!currentSession) return;

    setLoading(true);
    try {
      await fetch(`${API_BASE_URL}/stop-session/${currentSession.session_id}`, {
        method: 'POST'
      });
    } catch (err: any) {
      console.error(`Failed to stop session: ${err.message}`);
      // Even if API fails, we should stop local streams and reset UI
    } finally {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(track => track.stop());
      }

      if (eventSourceRef.current) {
        eventSourceRef.current.close();
      }

      setCurrentSession(null);
      setActiveView('home');
      setViolations([]);
      setSessionStatus(null);
      setViolationTypes(null);
      setLoading(false);
    }
  };

  const fetchSessionStatus = async () => {
    if (!currentSession) return;
    try {
      const response = await fetch(`${API_BASE_URL}/session-status/${currentSession.session_id}`);
      if (response.ok) {
        const data = await response.json();
        if (data.summary) {
          setSessionStatus({
            frames_processed: data.summary.frames_processed || 0,
            total_violations: data.summary.total_violations || 0,
            status: data.is_active ? 'active' : 'inactive'
          });
        }
      }
    } catch (err) {
      console.error('Error fetching status:', err);
    }
  };

  const fetchViolations = async () => {
    if (!currentSession) return;
    try {
      const response = await fetch(`${API_BASE_URL}/violations/${currentSession.session_id}/latest?count=10`);
      if (response.ok) {
        const data = await response.json();
        setViolations(data.violations || []);
      }
    } catch (err) {
      console.error('Error fetching violations:', err);
    }
  };

  const fetchViolationTypes = async () => {
    if (!currentSession) return;
    try {
      const response = await fetch(`${API_BASE_URL}/violations/${currentSession.session_id}/types`);
      if (response.ok) {
        const data = await response.json();
        setViolationTypes(data.violation_types);
      }
    } catch (err) {
      console.error('Error fetching violation types:', err);
    }
  };

  const setupViolationStream = () => {
    if (!currentSession) return;

    // Check if EventSource is supported
    if (typeof EventSource !== "undefined") {
      const eventSource = new EventSource(`${API_BASE_URL}/violations/${currentSession.session_id}/stream`);

      eventSource.onmessage = (event) => {
        try {
          const newViolation = JSON.parse(event.data);
          setViolations(prev => [newViolation, ...prev].slice(0, 10));
        } catch (e) {
          console.error("Error parsing SSE data", e);
        }
      };

      eventSource.onerror = () => {
        eventSource.close();
      };

      eventSourceRef.current = eventSource;
    }
  };

  const renderHome = () => (
    <div className="max-w-6xl mx-auto px-4 py-12">
      <div className="flex flex-col items-center justify-center text-center mb-16 space-y-4">
        <div className="bg-blue-100 p-4 rounded-full mb-4">
          <Shield size={48} className="text-blue-600" />
        </div>
        <h1 className="text-5xl font-extrabold text-transparent bg-clip-text bg-gradient-to-r from-blue-600 to-purple-600 mb-2">
          AI Proctor System
        </h1>
        <p className="text-xl text-gray-600 max-w-2xl">
          Advanced automated proctoring with real-time violation detection and analytics.
        </p>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-800 px-6 py-4 rounded-xl mb-8 flex items-center gap-3 shadow-sm max-w-3xl mx-auto">
          <AlertCircle size={24} className="flex-shrink-0" />
          <span className="font-medium">{error}</span>
          <button onClick={() => setError(null)} className="ml-auto hover:bg-red-100 p-1 rounded">
            <XCircle size={18} />
          </button>
        </div>
      )}

      <div className="grid md:grid-cols-2 gap-8 mb-16 max-w-4xl mx-auto">
        <button
          onClick={() => startSession('video-only')}
          disabled={loading}
          className="group relative overflow-hidden bg-white p-8 rounded-2xl shadow-lg border border-gray-100 hover:shadow-xl transition-all duration-300 disabled:opacity-70 disabled:cursor-not-allowed text-left"
        >
          <div className="absolute top-0 right-0 p-4 opacity-10 group-hover:opacity-20 transition-opacity">
            <Camera size={120} className="text-blue-500" />
          </div>
          <div className="relative z-10">
            <div className="bg-blue-100 w-14 h-14 rounded-xl flex items-center justify-center mb-6 group-hover:scale-110 transition-transform duration-300">
              <Camera size={28} className="text-blue-600" />
            </div>
            <h3 className="text-2xl font-bold text-gray-800 mb-2">Video Only Session</h3>
            <p className="text-gray-500 mb-6">Monitor exam environment using camera feed only. Best for standard proctoring.</p>
            <div className="flex items-center text-blue-600 font-semibold group-hover:translate-x-2 transition-transform">
              Start Session <Play size={16} className="ml-2" />
            </div>
          </div>
        </button>

        <button
          onClick={() => startSession('audio-video')}
          disabled={loading}
          className="group relative overflow-hidden bg-white p-8 rounded-2xl shadow-lg border border-gray-100 hover:shadow-xl transition-all duration-300 disabled:opacity-70 disabled:cursor-not-allowed text-left"
        >
          <div className="absolute top-0 right-0 p-4 opacity-10 group-hover:opacity-20 transition-opacity">
            <Video size={120} className="text-purple-500" />
          </div>
          <div className="relative z-10">
            <div className="bg-purple-100 w-14 h-14 rounded-xl flex items-center justify-center mb-6 group-hover:scale-110 transition-transform duration-300">
              <Video size={28} className="text-purple-600" />
            </div>
            <h3 className="text-2xl font-bold text-gray-800 mb-2">Audio + Video Session</h3>
            <p className="text-gray-500 mb-6">Full environmental monitoring with both audio and video analysis.</p>
            <div className="flex items-center text-purple-600 font-semibold group-hover:translate-x-2 transition-transform">
              Start Session <Play size={16} className="ml-2" />
            </div>
          </div>
        </button>
      </div>

      <div className="bg-white rounded-2xl shadow-lg border border-gray-100 overflow-hidden max-w-4xl mx-auto">
        <div className="p-6 border-b border-gray-100 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="bg-gray-100 p-2 rounded-lg">
              <Users size={20} className="text-gray-700" />
            </div>
            <h2 className="text-xl font-bold text-gray-800">Active Sessions</h2>
          </div>
          <button onClick={fetchActiveSessions} className="text-gray-400 hover:text-gray-600 transition-colors">
            <RefreshCw size={18} />
          </button>
        </div>

        <div className="p-2">
          {sessions.length === 0 ? (
            <div className="text-gray-400 text-center py-12 flex flex-col items-center">
              <Users size={48} className="mb-3 opacity-20" />
              <p>No active sessions detected</p>
            </div>
          ) : (
            <div className="space-y-1">
              {sessions.map((session, idx) => (
                <div key={idx} className="flex justify-between items-center p-4 hover:bg-gray-50 rounded-xl transition-colors">
                  <div className="flex items-center gap-3">
                    <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse"></div>
                    <span className="font-mono text-sm text-gray-600">{session.session_id}</span>
                  </div>
                  <span className="text-xs font-medium px-3 py-1 bg-gray-100 text-gray-600 rounded-full border border-gray-200 capitalize">
                    {session.session_type}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );

  const renderMonitoring = () => (
    <div className="max-w-7xl mx-auto px-4 py-8">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center mb-8 gap-4">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-800">
              <span className="w-1.5 h-1.5 rounded-full bg-red-600 animate-pulse"></span>
              LIVE
            </span>
            <h1 className="text-3xl font-bold text-gray-800">Proctor Dashboard</h1>
          </div>
          <p className="text-gray-500 font-mono text-sm">
            ID: {currentSession?.session_id}
          </p>
        </div>
        <button
          onClick={stopSession}
          disabled={loading}
          className="bg-red-500 hover:bg-red-600 disabled:bg-gray-400 text-white px-6 py-3 rounded-xl shadow-lg shadow-red-500/30 flex items-center gap-2 transition-all transform hover:scale-105 active:scale-95 text-sm font-semibold"
        >
          <Square size={18} fill="currentColor" />
          End Session
        </button>
      </div>

      <div className="grid lg:grid-cols-3 gap-8">
        <div className="lg:col-span-2 space-y-8">
          <div className="bg-black rounded-2xl shadow-xl overflow-hidden relative aspect-video group">
            <video
              ref={videoRef}
              autoPlay
              playsInline
              muted
              className="w-full h-full object-cover"
              style={{ transform: 'scaleX(-1)' }}
            />
            <div className="absolute top-4 right-4 bg-black/50 backdrop-blur-sm text-white text-xs px-2 py-1 rounded flex items-center gap-1">
              <div className="w-2 h-2 bg-red-500 rounded-full animate-pulse"></div>
              Recording
            </div>
          </div>

          {sessionStatus && (
            <div className="grid grid-cols-3 gap-6">
              <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
                <div className="text-gray-500 text-sm font-medium mb-2">Frames Processed</div>
                <div className="text-3xl font-bold text-gray-800">{sessionStatus.frames_processed || 0}</div>
              </div>
              <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
                <div className="text-gray-500 text-sm font-medium mb-2">Violations</div>
                <div className="text-3xl font-bold text-red-600">{sessionStatus.total_violations || 0}</div>
              </div>
              <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
                <div className="text-gray-500 text-sm font-medium mb-2">Status</div>
                <div className="flex items-center gap-2">
                  <div className={`w-3 h-3 rounded-full ${sessionStatus.status === 'active' ? 'bg-green-500' : 'bg-gray-400'}`}></div>
                  <div className="text-xl font-bold text-gray-800 capitalize">
                    {sessionStatus.status || 'Unknown'}
                  </div>
                </div>
              </div>
            </div>
          )}

          {violationTypes && Object.keys(violationTypes).length > 0 && (
            <div className="bg-white rounded-2xl shadow-md border border-gray-100 p-6">
              <h3 className="text-lg font-bold text-gray-800 mb-6 flex items-center gap-2">
                <Radio size={20} className="text-blue-500" />
                Analytics
              </h3>
              <div className="space-y-4">
                {Object.entries(violationTypes).map(([type, count]) => (
                  <div key={type} className="flex items-center gap-4">
                    <span className="text-sm font-medium text-gray-600 w-32 capitalize">{type.replace('_', ' ')}</span>
                    <div className="flex-1 h-2 bg-gray-100 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-blue-500 rounded-full"
                        style={{ width: `${Math.min((count / (sessionStatus?.total_violations || 1)) * 100, 100)}%` }}
                      ></div>
                    </div>
                    <span className="text-sm font-bold text-gray-800 w-8 text-right">{count}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="bg-white rounded-2xl shadow-md border border-gray-100 flex flex-col h-[calc(100vh-12rem)] min-h-[500px]">
          <div className="p-6 border-b border-gray-100 flex items-center justify-between bg-gray-50/50 rounded-t-2xl">
            <div className="flex items-center gap-2">
              <AlertCircle size={20} className="text-red-500" />
              <h3 className="font-bold text-gray-800">Live Violations</h3>
            </div>
            <span className="bg-red-100 text-red-700 text-xs font-bold px-2 py-1 rounded-full">{violations.length}</span>
          </div>

          <div className="flex-1 overflow-y-auto p-4 space-y-3">
            {violations.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center text-gray-400 space-y-3">
                <CheckCircle size={48} className="text-green-500 opacity-20" />
                <p>Clean session. No violations detected.</p>
              </div>
            ) : (
              violations.map((violation, idx) => {
                const [type, ...descParts] = violation.details.split(':');
                const description = descParts.join(':').trim();

                return (
                  <div
                    key={idx}
                    className="bg-red-50/50 border border-red-100 rounded-xl p-4 transition-all hover:bg-red-50 hover:shadow-sm"
                  >
                    <div className="flex items-start gap-3">
                      <div className="bg-red-100 p-2 rounded-lg flex-shrink-0">
                        <XCircle size={18} className="text-red-600" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex justify-between items-start mb-1">
                          <h4 className="font-semibold text-red-900 capitalize text-sm">
                            {violation.violation_type || type || 'Violation'}
                          </h4>
                          <span className="text-xs text-gray-500 font-mono">
                            {new Date(violation.timestamp).toLocaleTimeString()}
                          </span>
                        </div>
                        <p className="text-sm text-gray-700 leading-snug mb-2">
                          {violation.description || description || violation.details}
                        </p>
                        {violation.confidence && (
                          <div className="flex items-center gap-2">
                            <div className="flex-1 h-1.5 bg-red-200 rounded-full overflow-hidden">
                              <div className="h-full bg-red-500" style={{ width: `${violation.confidence * 100}%` }}></div>
                            </div>
                            <span className="text-xs text-red-700 font-medium">{(violation.confidence * 100).toFixed(0)}%</span>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-gray-50">
      {activeView === 'home' ? renderHome() : renderMonitoring()}
    </div>
  );
};

export default App;
