# Bounded-memory parallel MP4 export

## Summary

Replace per-frame getImageData() allocations with a fixed raw-frame buffer pool, then export independent contiguous frame ranges
in parallel worker sessions. Use up to n−1 CPU cores but cap workers by an estimated 4 GiB renderer-memory budget. Workers encode
temporary video segments; the parent concatenates them and performs the existing audio mix once.

## Implementation changes

- Add an export-session builder shared by the CLI parent and Node worker threads:
    - prepare geometry/assets once in the parent;
    - each worker hydrates an isolated render session from that prepared payload;
    - workers render their assigned contiguous frame range directly, relying on the renderer’s frame-index purity and committed-
    stroke reconstruction rather than replaying earlier frames.

- Replace frame extraction through ctx.getImageData() with canvas.data() plus a small reusable raw-RGBA buffer pool.
    - Keep buffers alive until the ffmpeg write callback confirms consumption.
    - Preserve stdin backpressure and cap in-flight frames, eliminating unbounded ImageData/Buffer churn.

- Add an export scheduler:
    - compute targetWorkers = max(1, availableCores − 1);
    - estimate one render session from its padded clip surface areas, including artwork/compositing layers and the output frame;
    - use min(targetWorkers, floor(4 GiB / estimatedSessionBytes)), never below one worker;
    - partition frame indices into contiguous, non-overlapping ranges.

- Have each worker stream its range to its own temporary ffmpeg segment with a single encoder thread. This prevents encoder
threads from oversubscribing the remaining CPU core and avoids holding out-of-order raw frames in memory.

- Concatenate completed video segments in frame order, then run the existing audio filter graph once against the concatenated
video. The final pass copies the video stream and encodes/mixes audio only.

- Clean temporary segment files and export directories on success, worker failure, cancellation, and parent-process exit. Surface
worker/ffmpeg errors with the failing range and preserved stderr tail.

- Keep the existing single-process exporter as a fallback when worker threads or segment encoding cannot start.

## Interfaces and behavior

- Extend the export driver options with an optional parallel-export configuration (worker target, memory budget, temporary
directory); default it to the adaptive 4 GiB policy.

- Add a lightweight progress model that aggregates completed worker frames and final concat/mux progress, while retaining the
existing frame/total UI IPC contract.

- Existing projects and output settings remain compatible. Decoded video frames must match the sequential renderer; only H.264
compression boundaries may differ internally.

## Test plan

- Verify raw canvas bytes match the existing RGBA extraction and that reusable buffers never exceed the configured pool size.
- Verify worker-count calculation honors n−1, the 4 GiB estimate, and the one-worker minimum.
- Render a fixture sequentially and through multiple frame ranges; compare decoded RGBA frames and frame count.
- Add failure/cleanup tests for a worker or ffmpeg segment failure, and retain full export tests.

## Assumptions

- The 4 GiB budget applies to estimated renderer sessions and queued raw frames, not total system RAM or ffmpeg’s own codec
buffers.

- Parallel export prioritizes identical decoded frames and bounded memory; bit-for-bit H.264 output may differ from the old
single-stream export because segments reset encoder state.