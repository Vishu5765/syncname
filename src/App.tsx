import React, { useState, useEffect, useRef } from "react";
import { io, Socket } from "socket.io-client";
import { Play, Pause, Lock, Unlock, Plus, Users, Music, Activity, Skull, X, User, Upload, RotateCcw, FastForward, Rewind } from "lucide-react";

// Brutalist Simple UI Styles
const BRUTAL_CLASSES = {
  container: "min-h-screen bg-[#E4E3E0] text-[#141414] font-mono p-4 md:p-8",
  card: "border-2 border-[#141414] bg-white p-6 shadow-[4px_4px_0px_0px_#141414] mb-8",
  button: "border-2 border-[#141414] bg-white px-4 py-2 hover:bg-[#141414] hover:text-[#E4E3E0] transition-colors font-bold flex items-center gap-2 disabled:opacity-50",
  killButton: "border-2 border-red-600 bg-white text-red-600 px-2 py-1 hover:bg-red-600 hover:text-white transition-colors font-bold flex items-center gap-1 text-[10px] uppercase",
  input: "border-2 border-[#141414] bg-white px-4 py-2 focus:outline-none w-full mb-4",
  label: "text-xs uppercase tracking-widest opacity-60 mb-2 block",
  badge: "inline-block px-2 py-1 text-xs border border-[#141414] mb-2",
};

export default function App() {
  const [username, setUsername] = useState("");
  const [isSignedUp, setIsSignedUp] = useState(false);
  const [role, setRole] = useState<"none" | "main" | "client">("none");
  const [roomKey, setRoomKey] = useState("");
  const [inputRoomKey, setInputRoomKey] = useState("");
  const [isLocked, setIsLocked] = useState(false);
  const [syncStatus, setSyncStatus] = useState("Not Synced");
  const [error, setError] = useState("");
  const [killedMessage, setKilledMessage] = useState("");
  const [audioUrl, setAudioUrl] = useState("");
  const [isPlaying, setIsPlaying] = useState(false);
  const [isLooping, setIsLooping] = useState(false);
  const [userList, setUserList] = useState<[string, string][]>([]);
  const [showUserList, setShowUserList] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [audioSuspended, setAudioSuspended] = useState(false);

  const socketRef = useRef<Socket | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const audioBufferRef = useRef<AudioBuffer | null>(null);
  const sourceNodeRef = useRef<AudioBufferSourceNode | null>(null);
  const serverOffsetRef = useRef<number>(0);
  const currentOffsetRef = useRef<number>(0);
  const lastPlayTimeRef = useRef<number>(0);

  useEffect(() => {
    socketRef.current = io();

    socketRef.current.on("room-created", ({ roomKey, username }) => {
      setRoomKey(roomKey);
      setUsername(username);
    });

    socketRef.current.on("joined-room", ({ roomKey, username, audioState }) => {
      setRoomKey(roomKey);
      setUsername(username);
      if (audioState) {
        setAudioUrl(audioState.audioUrl);
        if (audioState.playing) {
          handleRemotePlay(audioState.audioUrl, audioState.startTime, audioState.offset, !!audioState.loop);
        }
      }
    });

    socketRef.current.on("room-lock-status", (status) => setIsLocked(status));
    socketRef.current.on("user-list", (list) => setUserList(list));
    socketRef.current.on("error", (msg) => setError(msg));
    socketRef.current.on("killed", (msg) => {
      setKilledMessage(msg);
      setRole("none");
      setRoomKey("");
      stopAudio();
    });

    socketRef.current.on("audio-play", ({ audioUrl, startTime, offset, loop }) => {
      setIsLooping(!!loop);
      handleRemotePlay(audioUrl, startTime, offset, !!loop);
    });

    socketRef.current.on("audio-pause", () => {
      handleRemotePause();
    });

    socketRef.current.on("audio-seek", ({ offset, startTime, loop }) => {
      if (loop !== undefined) setIsLooping(loop);
      handleRemoteSeek(offset, startTime, loop);
    });

    const syncInterval = setInterval(syncClock, 5000);
    syncClock();

    // Monitor audio context state
    const stateInterval = setInterval(() => {
      if (audioContextRef.current?.state === "suspended") {
        setAudioSuspended(true);
      } else if (audioContextRef.current?.state === "running") {
        setAudioSuspended(false);
      }
    }, 1000);

    return () => {
      clearInterval(syncInterval);
      clearInterval(stateInterval);
      socketRef.current?.disconnect();
    };
  }, []);

  const syncClock = () => {
    if (!socketRef.current) return;
    const clientTimestamp = Date.now();
    socketRef.current.emit("sync-request", clientTimestamp);
    socketRef.current.once("sync-response", ({ clientTimestamp: originalClientTimestamp, serverTimestamp }) => {
      const now = Date.now();
      const rtt = now - originalClientTimestamp;
      const offset = serverTimestamp - (now + originalClientTimestamp) / 2;
      serverOffsetRef.current = offset;
      setSyncStatus(`Synced (RTT: ${rtt}ms)`);
    });
  };

  const getServerTime = () => Date.now() + serverOffsetRef.current;

  const initAudio = async () => {
    if (!audioContextRef.current) {
      audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
    }
    if (audioContextRef.current.state === "suspended") {
      await audioContextRef.current.resume();
    }
    setAudioSuspended(false);
  };

  const loadAudio = async (url: string) => {
    initAudio();
    console.log(`Loading audio from: ${url}`);
    setSyncStatus("Loading Audio...");
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
      const arrayBuffer = await response.arrayBuffer();
      const audioBuffer = await audioContextRef.current!.decodeAudioData(arrayBuffer);
      audioBufferRef.current = audioBuffer;
      setSyncStatus("Audio Loaded");
      return audioBuffer;
    } catch (err) {
      console.error("Audio Load Error:", err);
      setError("Failed to load audio. Please ensure the file is a valid audio format.");
      setSyncStatus("Load Failed");
      return null;
    }
  };

  const playAudio = (buffer: AudioBuffer, startTime: number, offset: number, loop: boolean) => {
    if (!audioContextRef.current) return;
    stopAudio();
    const source = audioContextRef.current.createBufferSource();
    source.buffer = buffer;
    source.loop = loop;
    source.connect(audioContextRef.current.destination);
    
    const nowServer = getServerTime();
    const delay = (startTime - nowServer) / 1000;
    const targetTime = audioContextRef.current.currentTime + delay;
    
    let actualOffset = offset;
    let actualTargetTime = targetTime;
    
    if (delay < 0) {
      actualOffset = offset + Math.abs(delay);
      actualTargetTime = audioContextRef.current.currentTime;
    }

    source.start(actualTargetTime, actualOffset);
    sourceNodeRef.current = source;
    setIsPlaying(true);
    currentOffsetRef.current = actualOffset;
    lastPlayTimeRef.current = getServerTime();
  };

  const stopAudio = () => {
    if (sourceNodeRef.current) {
      try { sourceNodeRef.current.stop(); } catch (e) {}
      sourceNodeRef.current = null;
    }
    setIsPlaying(false);
  };

  const handleRemotePlay = async (url: string, startTime: number, offset: number, loop: boolean) => {
    setAudioUrl(url);
    const finalUrl = url.startsWith("/") ? `${window.location.origin}${url}` : url;
    const buffer = await loadAudio(finalUrl);
    if (buffer) playAudio(buffer, startTime, offset, loop);
  };

  const handleRemotePause = () => stopAudio();

  const handleRemoteSeek = (offset: number, startTime: number, loop?: boolean) => {
    if (audioBufferRef.current) playAudio(audioBufferRef.current, startTime, offset, loop ?? isLooping);
  };

  const handleSignUp = (e: React.FormEvent) => {
    e.preventDefault();
    if (username.trim()) setIsSignedUp(true);
  };

  const createRoom = () => {
    initAudio();
    setRole("main");
    socketRef.current?.emit("create-room", username);
  };

  const joinRoom = () => {
    if (!inputRoomKey) return;
    initAudio();
    setRole("client");
    socketRef.current?.emit("join-room", { roomKey: inputRoomKey, username });
  };

  const toggleLock = () => socketRef.current?.emit("lock-room", roomKey);

  const requestSync = () => {
    setSyncStatus("Requesting Sync...");
    socketRef.current?.emit("request-sync", roomKey);
  };

  const killUser = (targetId: string) => {
    socketRef.current?.emit("kill-user", { roomKey, targetId });
  };

  const hostPlay = () => {
    if (!audioUrl) return;
    socketRef.current?.emit("play-audio", { roomKey, audioUrl, offset: 0, loop: isLooping });
  };

  const hostPause = () => socketRef.current?.emit("pause-audio", roomKey);

  const hostSeek = (newOffset: number) => {
    const duration = audioBufferRef.current?.duration || 0;
    const clampedOffset = Math.max(0, Math.min(newOffset, duration));
    socketRef.current?.emit("seek-audio", { roomKey, offset: clampedOffset, loop: isLooping });
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setUploading(true);
    setUploadProgress(0);
    const formData = new FormData();
    formData.append("audio", file);

    try {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", "/api/upload", true);
      
      xhr.timeout = 600000; // 10 minutes
      
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) {
          const percentComplete = (event.loaded / event.total) * 100;
          setUploadProgress(percentComplete);
        }
      };

      xhr.onload = () => {
        if (xhr.status === 200) {
          try {
            const data = JSON.parse(xhr.responseText);
            setAudioUrl(data.url);
            setUploading(false);
          } catch (e) {
            setError("Server returned invalid response.");
            setUploading(false);
          }
        } else {
          try {
            const data = JSON.parse(xhr.responseText);
            setError(data.error || "Failed to upload file.");
          } catch (e) {
            setError(`Upload failed with status: ${xhr.status}`);
          }
          setUploading(false);
        }
      };

      xhr.onerror = () => {
        setError("Network error during upload. Check your connection.");
        setUploading(false);
      };

      xhr.ontimeout = () => {
        setError("Upload timed out. The file might be too large for your current connection.");
        setUploading(false);
      };

      xhr.send(formData);
    } catch (err) {
      console.error("Upload Error:", err);
      setError("Failed to upload file.");
      setUploading(false);
    }
  };

  const toggleLoop = () => {
    const nextLoop = !isLooping;
    setIsLooping(nextLoop);
    if (isPlaying) {
      // Re-emit with current offset to update all clients' loop state
      const elapsed = (getServerTime() - lastPlayTimeRef.current) / 1000;
      const currentOffset = currentOffsetRef.current + elapsed;
      socketRef.current?.emit("seek-audio", { roomKey, offset: currentOffset, loop: nextLoop });
    }
  };

  const skip10 = (direction: number) => {
    const elapsed = (getServerTime() - lastPlayTimeRef.current) / 1000;
    const currentOffset = currentOffsetRef.current + elapsed;
    hostSeek(currentOffset + (direction * 10));
  };

  if (killedMessage) {
    return (
      <div className={`${BRUTAL_CLASSES.container} flex items-center justify-center`}>
        <div className={`${BRUTAL_CLASSES.card} text-center max-w-md`}>
          <Skull size={64} className="mx-auto mb-4 text-red-600" />
          <h1 className="text-4xl font-black uppercase mb-4">YOU ARE KILLED</h1>
          <p className="text-xl font-bold mb-6">{killedMessage}</p>
          <button onClick={() => setKilledMessage("")} className={BRUTAL_CLASSES.button + " w-full justify-center"}>
            Try Again
          </button>
        </div>
      </div>
    );
  }

  if (!isSignedUp) {
    return (
      <div className={BRUTAL_CLASSES.container}>
        <div className="max-w-md mx-auto mt-20">
          <h1 className="text-6xl font-black mb-8 italic uppercase tracking-tighter">SonicSync</h1>
          <div className={BRUTAL_CLASSES.card}>
            <form onSubmit={handleSignUp}>
              <label className={BRUTAL_CLASSES.label}>Enter Username</label>
              <input 
                type="text" 
                placeholder="USERNAME" 
                className={BRUTAL_CLASSES.input}
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                required
              />
              <button type="submit" className={`${BRUTAL_CLASSES.button} w-full`}>
                <User size={20} /> Start Syncing
              </button>
            </form>
          </div>
        </div>
      </div>
    );
  }

  if (role === "none") {
    return (
      <div className={BRUTAL_CLASSES.container}>
        <div className="max-w-md mx-auto mt-20">
          <div className="flex justify-between items-center mb-8">
            <h1 className="text-6xl font-black italic uppercase tracking-tighter">SonicSync</h1>
            <div className="text-right">
              <span className="text-[10px] uppercase opacity-50 block">Logged in as</span>
              <span className="font-bold">{username}</span>
            </div>
          </div>
          <div className={BRUTAL_CLASSES.card}>
            <label className={BRUTAL_CLASSES.label}>Host a Session</label>
            <button onClick={createRoom} className={`${BRUTAL_CLASSES.button} w-full mb-8`}>
              <Plus size={20} /> Create Group
            </button>
            
            <div className="border-t-2 border-[#141414] pt-8">
              <label className={BRUTAL_CLASSES.label}>Join a Session</label>
              <input 
                type="text" 
                placeholder="4-DIGIT KEY" 
                className={BRUTAL_CLASSES.input}
                value={inputRoomKey}
                onChange={(e) => setInputRoomKey(e.target.value)}
              />
              <button onClick={joinRoom} className={`${BRUTAL_CLASSES.button} w-full`}>
                <Users size={20} /> Join Group
              </button>
            </div>
          </div>
          {error && <div className="bg-red-500 text-white p-2 text-xs font-bold">{error}</div>}
        </div>
      </div>
    );
  }

  return (
    <div className={BRUTAL_CLASSES.container}>
      <div className="max-w-4xl mx-auto">
        <div className="flex justify-between items-end mb-8">
          <div>
            <h1 className="text-4xl font-black italic uppercase tracking-tighter">SonicSync</h1>
            <div className={BRUTAL_CLASSES.badge}>{role === "main" ? "HOST" : "CLIENT"}</div>
          </div>
          <div className="text-right">
            <label className={BRUTAL_CLASSES.label}>Room Key</label>
            <div className="text-4xl font-black">{roomKey}</div>
          </div>
        </div>

        <div className="grid md:grid-cols-3 gap-8">
          <div className="md:col-span-2">
            <div className={BRUTAL_CLASSES.card}>
              <label className={BRUTAL_CLASSES.label}>Audio Source</label>
              {role === "main" ? (
                <div className="space-y-4 mb-4">
                  <div className="flex items-center gap-4">
                    <label className={`${BRUTAL_CLASSES.button} cursor-pointer flex-grow justify-center h-16 text-xl`}>
                      <Upload size={24} /> {uploading ? "Uploading..." : "Upload from Device"}
                      <input type="file" accept="audio/*" className="hidden" onChange={handleFileUpload} disabled={uploading} />
                    </label>
                  </div>
                  {audioUrl && (
                    <div className="text-xs font-bold truncate border-b border-[#141414] pb-2">
                      FILE: {audioUrl.split('/').pop()?.split('-').slice(1).join('-')}
                    </div>
                  )}
                </div>
              ) : (
                <div className="mb-4 font-bold flex items-center gap-2">
                  <Music size={16} />
                  {audioUrl ? audioUrl.split('/').pop()?.split('-').slice(1).join('-') : "Waiting for Host..."}
                </div>
              )}

              <div className="space-y-6">
                <div className="flex items-center gap-4">
                  {role === "main" ? (
                    <>
                      <button onClick={() => skip10(-1)} className={BRUTAL_CLASSES.button} title="Back 10s">
                        <Rewind size={20} />
                      </button>
                      <button onClick={isPlaying ? hostPause : hostPlay} className={`${BRUTAL_CLASSES.button} flex-grow justify-center py-4`}>
                        {isPlaying ? <Pause size={32} /> : <Play size={32} />}
                      </button>
                      <button onClick={() => skip10(1)} className={BRUTAL_CLASSES.button} title="Forward 10s">
                        <FastForward size={20} />
                      </button>
                      <button 
                        onClick={toggleLoop} 
                        className={`${BRUTAL_CLASSES.button} ${isLooping ? "bg-[#141414] text-white" : ""}`}
                        title="Toggle Loop"
                      >
                        <RotateCcw size={20} />
                      </button>
                    </>
                  ) : (
                    <div className="flex items-center gap-4 w-full">
                      <div className="flex items-center gap-2 opacity-50">
                        {isPlaying ? <Activity className="animate-pulse" /> : <Pause />}
                        <span className="text-xs uppercase font-bold">{isPlaying ? "Playing In Sync" : "Paused"}</span>
                      </div>
                      <button onClick={requestSync} className={BRUTAL_CLASSES.button + " text-[10px] py-1"} title="Re-sync with Host">
                        <RotateCcw size={14} /> Sync
                      </button>
                      {isLooping && <div className="text-[10px] bg-[#141414] text-white px-2 py-1 uppercase font-bold">Loop Active</div>}
                    </div>
                  )}
                </div>

                {role === "main" && (
                  <input 
                    type="range" 
                    className="w-full accent-[#141414]" 
                    min="0" 
                    max={audioBufferRef.current?.duration || 100} 
                    step="0.1"
                    value={currentOffsetRef.current + (isPlaying ? (getServerTime() - lastPlayTimeRef.current) / 1000 : 0)}
                    onChange={(e) => hostSeek(parseFloat(e.target.value))}
                  />
                )}
              </div>
            </div>
          </div>

          <div>
            <div className={BRUTAL_CLASSES.card}>
              <div className="flex justify-between items-center mb-4">
                <label className={BRUTAL_CLASSES.label}>Session Status</label>
                <button onClick={() => setShowUserList(true)} className="text-[10px] uppercase font-bold underline">Public List ({userList.length})</button>
              </div>
              
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2">
                  <div className={`w-3 h-3 rounded-full ${syncStatus.includes("Synced") ? "bg-green-500" : "bg-red-500"}`} />
                  <span className="text-xs font-bold uppercase">{syncStatus}</span>
                </div>
                
                {uploading && (
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] font-bold uppercase animate-pulse">Uploading...</span>
                    <div className="relative w-8 h-8">
                      <svg className="w-full h-full" viewBox="0 0 36 36">
                        <path
                          className="stroke-gray-200"
                          strokeWidth="4"
                          fill="none"
                          d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
                        />
                        <path
                          className="stroke-[#141414] transition-all duration-300"
                          strokeWidth="4"
                          strokeDasharray={`${uploadProgress}, 100`}
                          strokeLinecap="round"
                          fill="none"
                          d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
                        />
                      </svg>
                      <div className="absolute inset-0 flex items-center justify-center text-[8px] font-bold">
                        {Math.round(uploadProgress)}%
                      </div>
                    </div>
                  </div>
                )}
              </div>
              
              {role === "main" && (
                <button onClick={toggleLock} className={`${BRUTAL_CLASSES.button} w-full`}>
                  {isLocked ? <Lock size={16} /> : <Unlock size={16} />}
                  {isLocked ? "Unlock Room" : "Lock Room"}
                </button>
              )}
            </div>
          </div>
        </div>

        {/* Audio Context Resume Overlay */}
        {audioSuspended && role !== "none" && (
          <div className="fixed inset-0 bg-black/80 backdrop-blur-md flex items-center justify-center z-[100] p-4">
            <div className={`${BRUTAL_CLASSES.card} text-center max-w-sm bg-white`}>
              <Music size={48} className="mx-auto mb-4 animate-bounce" />
              <h2 className="text-2xl font-black uppercase mb-2">Audio Blocked</h2>
              <p className="text-sm font-bold mb-6">Browsers block audio until you interact. Click below to enable synchronized playback.</p>
              <button onClick={initAudio} className={BRUTAL_CLASSES.button + " w-full justify-center py-4 text-xl"}>
                <Activity size={24} /> Enable Audio Sync
              </button>
            </div>
          </div>
        )}

        {/* User List Modal */}
        {showUserList && (
          <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50 p-4">
            <div className={`${BRUTAL_CLASSES.card} w-full max-w-md mb-0`}>
              <div className="flex justify-between items-center mb-6 border-b-2 border-[#141414] pb-2">
                <h2 className="text-2xl font-black uppercase">Public List</h2>
                <button onClick={() => setShowUserList(false)}><X size={24} /></button>
              </div>
              <div className="space-y-2 max-h-[60vh] overflow-y-auto">
                {userList.map(([id, name]) => (
                  <div key={id} className="flex justify-between items-center p-2 border border-[#141414] hover:bg-gray-50">
                    <div className="flex items-center gap-2">
                      <User size={14} />
                      <span className="font-bold">{name}</span>
                      {id === socketRef.current?.id && <span className="text-[8px] bg-[#141414] text-white px-1">YOU</span>}
                    </div>
                    {role === "main" && id !== socketRef.current?.id && (
                      <button onClick={() => killUser(id)} className={BRUTAL_CLASSES.killButton}>
                        <Skull size={12} /> Kill
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {error && <div className="bg-red-500 text-white p-4 font-bold mb-4">{error}</div>}
      </div>
    </div>
  );
}
