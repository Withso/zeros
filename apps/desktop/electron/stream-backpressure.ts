export interface BackpressureSource {
  pause(): unknown;
  resume(): unknown;
}

export interface BackpressureSink {
  write(chunk: string | Buffer): boolean;
  once(event: string | symbol, listener: (...args: unknown[]) => void): unknown;
  removeListener(
    event: string | symbol,
    listener: (...args: unknown[]) => void,
  ): unknown;
}

/** Coordinate several readable sources that share one rotating writable. */
export function createSharedBackpressureGate(
  sources: readonly BackpressureSource[],
): {
  write: (sink: BackpressureSink, chunk: string | Buffer) => void;
  dispose: () => void;
} {
  // Rotation can replace the current sink while the preceding generation is
  // still draining. Keep every saturated generation in the set and resume the
  // shared stdout/stderr sources only after all of them have released pressure.
  const releases = new Map<BackpressureSink, () => void>();

  const releaseSink = (sink: BackpressureSink): void => {
    const release = releases.get(sink);
    if (!release) return;
    sink.removeListener("drain", release);
    sink.removeListener("close", release);
    sink.removeListener("error", release);
    releases.delete(sink);
    if (releases.size === 0) {
      for (const source of sources) source.resume();
    }
  };

  return {
    write(sink, chunk) {
      if (sink.write(chunk) || releases.has(sink)) return;
      const release = () => releaseSink(sink);
      releases.set(sink, release);
      sink.once("drain", release);
      // A rotating/end-of-process stream can close without a useful drain
      // notification. Either boundary releases the child streams safely.
      sink.once("close", release);
      sink.once("error", release);
      if (releases.size === 1) {
        for (const source of sources) source.pause();
      }
    },
    dispose() {
      const hadPressure = releases.size > 0;
      for (const [sink, release] of releases) {
        sink.removeListener("drain", release);
        sink.removeListener("close", release);
        sink.removeListener("error", release);
      }
      releases.clear();
      if (hadPressure) {
        for (const source of sources) source.resume();
      }
    },
  };
}
