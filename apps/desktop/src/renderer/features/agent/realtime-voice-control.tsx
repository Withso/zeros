import { useCallback, useEffect, useRef, useState } from "react";
import { Mic, MicOff, Volume2 } from "lucide-react";

import type { ChatThread } from "../../state/store";
import { Button, Input } from "../../shared/ui";
import { cn } from "../../shared/ui/cn";
import { callCodexCapability } from "./codex-capabilities-client";
import {
  float32ToPcm16Base64,
  pcm16Base64ToChannels,
} from "./realtime-audio";
import {
  subscribeCodexRealtimeAudio,
  useCodexRealtimeStatus,
} from "./realtime-voice-state";

const DEFAULT_VOICE = "alloy";

export function RealtimeVoiceControl({
  chat,
  active,
}: {
  chat: ChatThread;
  active: boolean;
}) {
  const realtime = useCodexRealtimeStatus(chat.id);
  const [voices, setVoices] = useState<string[]>([DEFAULT_VOICE]);
  const [voice, setVoice] = useState(DEFAULT_VOICE);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState<"start" | "stop" | "text" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const microphone = useRef<MicrophoneCapture | null>(null);
  const sendChain = useRef(Promise.resolve());
  const pendingAudioChunks = useRef(0);
  const playback = useRef<AudioContext | null>(null);
  const nextPlaybackAt = useRef(0);
  const nativeThreadId = chat.nativeSessionId;

  const call = useCallback(
    (operation: Parameters<typeof callCodexCapability>[0]["operation"], params: unknown) => {
      if (!chat.sessionId || !nativeThreadId) {
        throw new Error("Open a native Codex task before starting realtime voice.");
      }
      return callCodexCapability({
        operation,
        cwd: chat.folder,
        sessionId: chat.sessionId,
        params,
      });
    },
    [chat.folder, chat.sessionId, nativeThreadId],
  );

  useEffect(() => {
    if (!active || !nativeThreadId || !chat.sessionId) return;
    let cancelled = false;
    void call("thread.realtime.voices.list", { threadId: nativeThreadId }).then(
      (result) => {
        if (cancelled) return;
        const available = collectRealtimeVoices(result);
        if (available.length === 0) return;
        setVoices(available);
        setVoice((current) => (available.includes(current) ? current : available[0]!));
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [active, call, chat.sessionId, nativeThreadId]);

  useEffect(() => {
    return subscribeCodexRealtimeAudio(chat.id, (update) => {
      if (!active || update.threadId !== nativeThreadId) return;
      try {
        const context = playback.current ?? new AudioContext();
        playback.current = context;
        void context.resume();
        const channels = pcm16Base64ToChannels(update.data, update.numChannels);
        if (channels.length === 0 || channels[0]!.length === 0) return;
        const buffer = context.createBuffer(
          channels.length,
          channels[0]!.length,
          update.sampleRate,
        );
        channels.forEach((channel, index) => {
          const transferable = new Float32Array(channel.length);
          transferable.set(channel);
          buffer.copyToChannel(transferable, index);
        });
        const source = context.createBufferSource();
        source.buffer = buffer;
        source.connect(context.destination);
        const now = context.currentTime;
        const startAt = Math.max(now, Math.min(nextPlaybackAt.current, now + 2));
        source.start(startAt);
        nextPlaybackAt.current = startAt + buffer.duration;
      } catch (playbackError) {
        setError(
          playbackError instanceof Error
            ? playbackError.message
            : "Realtime audio playback failed.",
        );
      }
    });
  }, [active, chat.id, nativeThreadId]);

  const stopLocalCapture = useCallback(() => {
    microphone.current?.stop();
    microphone.current = null;
    pendingAudioChunks.current = 0;
  }, []);

  useEffect(() => {
    if (
      !active ||
      realtime.status === "closed" ||
      realtime.status === "error"
    ) {
      stopLocalCapture();
      if (!active && realtime.status === "active" && nativeThreadId) {
        void call("thread.realtime.stop", { threadId: nativeThreadId }).catch(
          () => undefined,
        );
      }
    }
  }, [active, call, nativeThreadId, realtime.status, stopLocalCapture]);

  useEffect(
    () => () => {
      stopLocalCapture();
      void playback.current?.close();
      playback.current = null;
    },
    [stopLocalCapture],
  );

  const start = async () => {
    if (!active || busy || !nativeThreadId) return;
    setBusy("start");
    setError(null);
    let prepared: PreparedMicrophone | null = null;
    try {
      prepared = await prepareMicrophone((chunk) => {
        // Bound transport backpressure. Dropping stale microphone chunks is
        // preferable to replaying seconds-old speech after the user stops.
        if (pendingAudioChunks.current >= 3) return;
        pendingAudioChunks.current += 1;
        sendChain.current = sendChain.current
          .then(async () => {
            await call("thread.realtime.appendAudio", {
              threadId: nativeThreadId,
              audio: chunk,
            });
          })
          .catch((sendError) => {
            setError(
              sendError instanceof Error
                ? sendError.message
                : "Microphone audio could not be sent.",
            );
          })
          .finally(() => {
            pendingAudioChunks.current = Math.max(
              0,
              pendingAudioChunks.current - 1,
            );
          });
      });
      await call("thread.realtime.start", {
        threadId: nativeThreadId,
        outputModality: "audio",
        voice,
        version: "v2",
        transport: { type: "websocket" },
        includeStartupContext: true,
        flushTranscriptTailOnSessionEnd: true,
      });
      microphone.current = prepared.start();
      prepared = null;
    } catch (startError) {
      prepared?.dispose();
      setError(
        startError instanceof Error
          ? startError.message
          : "Realtime voice could not start.",
      );
    } finally {
      setBusy(null);
    }
  };

  const stop = async () => {
    if (busy || !nativeThreadId) return;
    setBusy("stop");
    stopLocalCapture();
    try {
      await call("thread.realtime.stop", { threadId: nativeThreadId });
    } catch (stopError) {
      setError(
        stopError instanceof Error
          ? stopError.message
          : "Realtime voice could not stop.",
      );
    } finally {
      setBusy(null);
    }
  };

  const appendText = async (speak: boolean) => {
    const value = text.trim();
    if (!value || busy || !nativeThreadId) return;
    setBusy("text");
    setError(null);
    try {
      await call(
        speak
          ? "thread.realtime.appendSpeech"
          : "thread.realtime.appendText",
        speak
          ? { threadId: nativeThreadId, text: value }
          : { threadId: nativeThreadId, text: value, role: "user" },
      );
      setText("");
    } catch (textError) {
      setError(
        textError instanceof Error
          ? textError.message
          : "Realtime text could not be sent.",
      );
    } finally {
      setBusy(null);
    }
  };

  const running = realtime.status === "active" || microphone.current !== null;
  return (
    <div className="border-border1 bg-bg1 flex flex-col gap-2 rounded-lg border px-3 py-2.5">
      <div className="flex items-center gap-2">
        <Volume2 className="text-fg2 size-4 shrink-0" />
        <span className="text-fg1 text-sm font-medium">Codex realtime</span>
        <span
          className={cn(
            "text-xs",
            realtime.status === "error" ? "text-danger" : "text-fg2",
          )}
        >
          {running ? "Listening" : realtime.status === "error" ? "Error" : "Ready"}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <select
            className="border-border1 bg-bg2 text-fg1 h-8 rounded-md border px-2 text-xs"
            aria-label="Codex realtime voice"
            value={voice}
            disabled={running || busy !== null}
            onChange={(event) => setVoice(event.target.value)}
          >
            {voices.map((candidate) => (
              <option key={candidate} value={candidate}>
                {candidate}
              </option>
            ))}
          </select>
          <Button
            variant="outline"
            size="sm"
            disabled={!active || busy !== null}
            onClick={() => void (running ? stop() : start())}
          >
            {running ? <MicOff className="size-3.5" /> : <Mic className="size-3.5" />}
            {busy === "start" ? "Starting…" : busy === "stop" ? "Stopping…" : running ? "Stop" : "Start"}
          </Button>
        </div>
      </div>
      {running ? (
        <div className="flex items-center gap-2">
          <Input
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void appendText(false);
            }}
            placeholder="Send realtime text"
            aria-label="Codex realtime text"
          />
          <Button
            variant="ghost"
            size="sm"
            disabled={!text.trim() || busy !== null}
            onClick={() => void appendText(false)}
          >
            Send
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={!text.trim() || busy !== null}
            onClick={() => void appendText(true)}
          >
            Speak
          </Button>
        </div>
      ) : null}
      {error || realtime.message ? (
        <p className={cn("text-xs", error ? "text-danger" : "text-fg2")}>
          {error ?? realtime.message}
        </p>
      ) : null}
    </div>
  );
}

export function collectRealtimeVoices(result: unknown): string[] {
  const response = record(result);
  const voices = record(response.voices);
  const preferred = Array.isArray(voices.v2) ? voices.v2 : voices.v1;
  return Array.isArray(preferred)
    ? [...new Set(preferred.filter((item): item is string => typeof item === "string" && !!item))]
    : [];
}

interface PreparedMicrophone {
  start(): MicrophoneCapture;
  dispose(): void;
}

interface MicrophoneCapture {
  stop(): void;
}

async function prepareMicrophone(
  onChunk: (chunk: {
    data: string;
    sampleRate: number;
    numChannels: number;
    samplesPerChannel: number;
    itemId: null;
  }) => void,
): Promise<PreparedMicrophone> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("Microphone capture is unavailable in this renderer.");
  }
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });
  const context = new AudioContext({ sampleRate: 24_000 });
  const source = context.createMediaStreamSource(stream);
  const processor = context.createScriptProcessor(4096, 1, 1);
  const mute = context.createGain();
  mute.gain.value = 0;
  let running = false;
  processor.onaudioprocess = (event) => {
    if (!running) return;
    const input = event.inputBuffer;
    const channels = Array.from(
      { length: input.numberOfChannels },
      (_, index) => input.getChannelData(index),
    );
    const encoded = float32ToPcm16Base64(channels);
    if (!encoded.data) return;
    onChunk({
      ...encoded,
      sampleRate: context.sampleRate,
      itemId: null,
    });
  };

  const dispose = () => {
    running = false;
    processor.disconnect();
    source.disconnect();
    mute.disconnect();
    for (const track of stream.getTracks()) track.stop();
    void context.close();
  };
  return {
    start() {
      running = true;
      source.connect(processor);
      processor.connect(mute);
      mute.connect(context.destination);
      void context.resume();
      return { stop: dispose };
    },
    dispose,
  };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
