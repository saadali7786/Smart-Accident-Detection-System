
import React, { useState, useRef, useEffect, useCallback } from "react";
import {
  Upload,
  BrainCircuit,
  CheckCircle,
  AlertTriangle,
  Video,
  Download,
  RefreshCw,
  Clock,
  Zap,
  Eye,
} from "lucide-react";

const API_URL =
  import.meta.env.VITE_AI_API_URL || "http://127.0.0.1:5001";

const MAX_SIZE_MB = 100;
const ALLOWED_TYPES = [".mp4", ".avi", ".mov", ".mkv"];

export default function AIDetection() {
  const [file, setFile] = useState(null);
  const [fileError, setFileError] = useState("");
  const [uploadStatus, setUploadStatus] = useState("idle");
  const [uploadMessage, setUploadMessage] = useState("");
  const [localPreviewUrl, setLocalPreviewUrl] = useState("");

  const [detectStatus, setDetectStatus] = useState("idle");
  const [detectMessage, setDetectMessage] = useState("");
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState(null);

  const [aiBackendOnline, setAiBackendOnline] = useState(null);

  const pollRef = useRef(null);
  const resultVideoRef = useRef(null);
  const mountedRef = useRef(true);

  const clearDetectionPoll = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    checkAiStatus();

    return () => {
      mountedRef.current = false;
      clearDetectionPoll();
    };
  }, [clearDetectionPoll]);

  useEffect(() => {
    return () => {
      if (localPreviewUrl) {
        URL.revokeObjectURL(localPreviewUrl);
      }
    };
  }, [localPreviewUrl]);

  async function checkAiStatus() {
    try {
      const res = await fetch(`${API_URL}/api/ai/status`, {
        signal: AbortSignal.timeout(3000),
      });

      if (mountedRef.current) {
        setAiBackendOnline(res.ok);
      }
    } catch {
      if (mountedRef.current) {
        setAiBackendOnline(false);
      }
    }
  }

  function validateFile(f) {
    if (!f) {
      return "No file selected.";
    }

    const ext = "." + f.name.split(".").pop().toLowerCase();

    if (!ALLOWED_TYPES.includes(ext)) {
      return `Unsupported format "${ext}". Use MP4, AVI, MOV or MKV.`;
    }

    if (f.size > MAX_SIZE_MB * 1024 * 1024) {
      return `File exceeds ${MAX_SIZE_MB} MB (${(
        f.size /
        1024 /
        1024
      ).toFixed(1)} MB).`;
    }

    return "";
  }

  function handleFileChange(e) {
    const f = e.target.files?.[0] || null;

    setFile(f);
    setResult(null);
    setUploadStatus("idle");
    setUploadMessage("");
    setDetectStatus("idle");
    setDetectMessage("");
    setProgress(0);

    if (localPreviewUrl) {
      URL.revokeObjectURL(localPreviewUrl);
      setLocalPreviewUrl("");
    }

    if (f) {
      const err = validateFile(f);
      setFileError(err);

      if (!err) {
        setLocalPreviewUrl(URL.createObjectURL(f));
      }
    } else {
      setFileError("");
    }
  }

  async function handleUpload() {
    const err = validateFile(file);

    if (err) {
      setFileError(err);
      return;
    }

    setUploadStatus("uploading");
    setUploadMessage("Uploading video to AI backend...");
    setFileError("");

    try {
      const formData = new FormData();
      formData.append("file", file);

      const res = await fetch(`${API_URL}/api/ai/upload`, {
        method: "POST",
        body: formData,
      });

      const data = await res.json();

      if (!res.ok || !data.success) {
        throw new Error(
          data.detail || data.message || "Upload failed"
        );
      }

      if (!mountedRef.current) return;

      setUploadStatus("done");
      setUploadMessage(
        `Uploaded "${file.name}" (${(
          file.size /
          1024 /
          1024
        ).toFixed(1)} MB)`
      );
    } catch (err) {
      if (!mountedRef.current) return;

      setUploadStatus("error");
      setUploadMessage(err.message || "Upload failed.");
    }
  }

  async function handleDetect() {
    if (detectStatus === "running") {
      return;
    }

    if (!file || uploadStatus !== "done") {
      setDetectStatus("error");
      setDetectMessage("Please upload a video before starting detection.");
      return;
    }

    setDetectStatus("running");
    setDetectMessage("Starting YOLO vehicle detection...");
    setProgress(0);
    setResult(null);

    clearDetectionPoll();

    pollRef.current = setInterval(async () => {
      try {
        const res = await fetch(
          `${API_URL}/api/ai/processing-status`
        );

        if (!res.ok || !mountedRef.current) {
          return;
        }

        const data = await res.json();

        if (
          data.status === "processing" ||
          data.isProcessing
        ) {
          const currentProgress = data.progress || 0;
          setProgress(currentProgress);

          const processed = data.processedFrames || 0;
          const total = data.totalFrames || 0;

          setDetectMessage(
            total > 0
              ? `Processing frame ${processed} / ${total} (${currentProgress}%)`
              : `Processing frame ${processed}…`
          );
        } else if (data.status === "error") {
          setDetectMessage(
            data.error ||
              "The AI service reported a processing error."
          );
        }
      } catch (error) {
        if (mountedRef.current) {
          setDetectMessage(
            `Progress updates unavailable; detection continues. ${error.message}`
          );
        }
      }
    }, 1500);

    try {
      const res = await fetch(`${API_URL}/api/ai/detect`, {
        method: "POST",
      });

      const data = await res.json();

      clearDetectionPoll();

      if (!res.ok || !data.success) {
        throw new Error(
          data.detail || data.message || "Detection failed"
        );
      }

      if (!mountedRef.current) return;

      setProgress(100);
      setResult(data);
      setDetectStatus("done");
      setDetectMessage("Detection completed successfully.");
    } catch (err) {
      clearDetectionPoll();

      if (!mountedRef.current) return;

      setDetectStatus("error");
      setDetectMessage(err.message || "Detection failed.");
      setProgress(0);
    }
  }

  function handleReset() {
    clearDetectionPoll();

    setFile(null);
    setFileError("");
    setUploadStatus("idle");
    setUploadMessage("");
    setDetectStatus("idle");
    setDetectMessage("");
    setProgress(0);
    setResult(null);

    if (localPreviewUrl) {
      URL.revokeObjectURL(localPreviewUrl);
      setLocalPreviewUrl("");
    }

    const fileInput = document.getElementById("ai-file-input");

    if (fileInput) {
      fileInput.value = "";
    }
  }

  const isUploaded = uploadStatus === "done";
  const isRunning = detectStatus === "running";
  const isDone = detectStatus === "done";

  return (
    <section className="panel ai-detection-panel">
      <div className="panel-heading">
        <div>
          <span className="section-kicker">
            ARTIFICIAL INTELLIGENCE
          </span>

          <h2>AI Vehicle Detection</h2>

          <p>
            Upload traffic footage for YOLO + ByteTrack vehicle
            detection and potential accident indicator analysis.
          </p>
        </div>

        <BrainCircuit size={26} />
      </div>

      {aiBackendOnline === false && (
        <div className="ai-backend-warning">
          <AlertTriangle size={16} />

          AI backend offline. Start it with:{" "}
          <code>
            uvicorn api:app --app-dir AI --port 5001
          </code>

          <button
            className="ai-retry-btn"
            onClick={checkAiStatus}
            type="button"
          >
            <RefreshCw size={14} /> Retry
          </button>
        </div>
      )}

      {aiBackendOnline === null && (
        <div className="ai-backend-checking">
          <Clock size={14} /> Checking AI backend…
        </div>
      )}

      {/* 01 - Upload Video */}
      <div className="ai-section">
        <div className="ai-section-title">
          <span className="workflow-number">01</span>
          Upload Video
        </div>

        <div className="ai-upload-area">
          <Video size={35} />

          <h3>Select Traffic Video</h3>

          <p>
            MP4, AVI, MOV or MKV — max {MAX_SIZE_MB} MB
          </p>

          <input
            type="file"
            accept=".mp4,.avi,.mov,.mkv"
            onChange={handleFileChange}
            id="ai-file-input"
            style={{ display: "none" }}
          />

          <label
            htmlFor="ai-file-input"
            className="primary-button ai-file-label"
          >
            <Upload size={15} /> Choose File
          </label>

          {file && !fileError && (
            <p className="ai-file-info">
              <strong>{file.name}</strong> —{" "}
              {(file.size / 1024 / 1024).toFixed(1)} MB
            </p>
          )}

          {fileError && (
            <p className="ai-error">
              <AlertTriangle size={15} /> {fileError}
            </p>
          )}
        </div>

        {localPreviewUrl && (
          <div className="ai-video-wrap">
            <div className="ai-video-label">
              <Eye size={14} /> Original Video Preview
            </div>

            <video
              controls
              width="100%"
              src={localPreviewUrl}
              className="ai-video-player"
            />
          </div>
        )}

        <button
          className="primary-button"
          onClick={handleUpload}
          type="button"
          disabled={
            !file ||
            !!fileError ||
            uploadStatus === "uploading" ||
            aiBackendOnline === false
          }
        >
          <Upload size={16} />

          {uploadStatus === "uploading"
            ? "Uploading…"
            : "Upload to AI Backend"}
        </button>

        {uploadMessage && (
          <p
            className={
              uploadStatus === "error"
                ? "ai-error"
                : "ai-success"
            }
          >
            {uploadStatus === "done" && (
              <CheckCircle size={15} />
            )}

            {uploadStatus === "error" && (
              <AlertTriangle size={15} />
            )}

            {uploadMessage}
          </p>
        )}
      </div>

      {/* 02 - YOLO Detection */}
      <div className="ai-section">
        <div className="ai-section-title">
          <span className="workflow-number">02</span>
          YOLO Detection &amp; Accident Analysis
        </div>

        <div className="ai-info-box">
          <BrainCircuit size={14} />

          Tracks vehicles using YOLO11n + ByteTrack and
          classifies observed indicators as potential or
          suspected. Video-only analysis does not confirm a crash.
        </div>

        <button
          className="primary-button"
          onClick={handleDetect}
          type="button"
          disabled={
            !isUploaded ||
            isRunning ||
            aiBackendOnline === false
          }
        >
          <Zap size={16} />

          {isRunning
            ? "Processing…"
            : isDone
              ? "Re-run Detection"
              : "Start AI Detection"}
        </button>

        {isRunning && (
          <div className="ai-progress-wrap">
            <div className="ai-progress-bar">
              <div
                className="ai-progress-fill"
                style={{ width: `${progress}%` }}
              />
            </div>

            <span className="ai-progress-label">
              {progress}%
            </span>

            <p className="ai-progress-message">
              {detectMessage}
            </p>
          </div>
        )}

        {detectMessage && !isRunning && (
          <p
            className={
              detectStatus === "error"
                ? "ai-error"
                : "ai-success"
            }
          >
            {isDone && <CheckCircle size={15} />}

            {detectStatus === "error" && (
              <AlertTriangle size={15} />
            )}

            {detectMessage}
          </p>
        )}
      </div>

      {/* Detection Results */}
      {result && (
        <>
          {/* 03 - Statistics */}
          <div className="ai-section">
            <div className="ai-section-title">
              <span className="workflow-number">03</span>
              Detection Statistics
            </div>

            <div className="dsa-summary">
              <div>
                <span>Vehicle Detections</span>
                <strong>
                  {(
                    result.total_vehicle_detections ?? 0
                  ).toLocaleString()}
                </strong>
              </div>

              <div>
                <span>Overall Assessment</span>
                <strong>
                  {result.overall_classification_label || "—"}
                </strong>
              </div>

              <div>
                <span>Processed Frames</span>
                <strong>
                  {(
                    result.processed_frames ?? 0
                  ).toLocaleString()}
                </strong>
              </div>

              <div>
                <span>Unique Vehicle IDs</span>
                <strong>
                  {result.unique_tracking_ids ?? 0}
                </strong>
              </div>

              <div>
                <span>Video Duration</span>
                <strong>
                  {result.videoDurationSeconds != null
                    ? `${result.videoDurationSeconds}s`
                    : "—"}
                </strong>
              </div>

              <div>
                <span>Potential Events</span>
                <strong>
                  {result.accident_analysis
                    ?.potential_accident_count ?? 0}
                </strong>
              </div>

              <div>
                <span>Suspected Events</span>
                <strong>
                  {result.suspected_accident_count ?? 0}
                </strong>
              </div>

              <div>
                <span>Confirmed Events</span>
                <strong>
                  {result.confirmed_accident_count ?? 0}
                </strong>
              </div>

              <div>
                <span>Queued for C++</span>
                <strong>
                  {result.queued_for_backend ?? "Not reported"}
                </strong>
              </div>

              <div>
                <span>FPS</span>
                <strong>{result.fps ?? "—"}</strong>
              </div>
            </div>

            {result.note && (
              <p className="ai-disclaimer">
                <AlertTriangle size={13} /> {result.note}
              </p>
            )}

            {result.forwarding_note && (
              <p className="ai-disclaimer">
                {result.forwarding_note}
              </p>
            )}
          </div>

          {/* 04 - Flagged Events */}
          <div className="ai-section">
            <div className="ai-section-title">
              <span className="workflow-number">04</span>
              Flagged Events

              {result.potential_accidents?.length > 0 && (
                <span className="event-count">
                  {result.potential_accidents.length}
                </span>
              )}
            </div>

            {result.potential_accidents?.length > 0 ? (
              <div className="dsa-event-list">
                {result.potential_accidents.map((ev, idx) => (
                  <div
                    className="dsa-event-card ai-event-card"
                    key={ev.event_id || idx}
                  >
                    <div className="dsa-event-header">
                      <strong>
                        {ev.classification_label || ev.label}
                      </strong>

                      <span
                        className={`event-badge ${
                          ev.classification ===
                          "suspected_accident"
                            ? "severe"
                            : "moderate"
                        }`}
                      >
                        {ev.confidence} confidence
                      </span>
                    </div>

                    <p>
                      Time: {ev.timestamp} &nbsp;|&nbsp;
                      Frame: {ev.frame}
                    </p>

                    <p>
                      Vehicle IDs:{" "}
                      {(ev.involved_vehicle_ids || []).join(", ")}
                    </p>

                    <p>{ev.reason}</p>

                    {ev.evidence?.length > 0 && (
                      <ul className="ai-evidence-list">
                        {ev.evidence.map((item, index) => (
                          <li
                            key={`${item.type || "evidence"}-${index}`}
                          >
                            {item.label} ({item.observations}{" "}
                            observation
                            {item.observations === 1 ? "" : "s"})
                          </li>
                        ))}
                      </ul>
                    )}

                    <small>
                      Visual indicators only. Independent
                      validation is required; this analysis does
                      not confirm an accident.
                    </small>
                  </div>
                ))}
              </div>
            ) : (
              <div className="empty-state">
                <CheckCircle size={22} />

                <p>
                  {result.overall_classification === "uncertain"
                    ? "Accident status is uncertain."
                    : "No potential accident indicators were flagged."}
                </p>

                <span>
                  {result.overall_classification === "uncertain"
                    ? "There was not enough reliable tracking evidence to assess traffic."
                    : "This video-only analysis cannot establish that no accident occurred."}
                </span>
              </div>
            )}
          </div>

          {/* 05 - Processed Video */}
          <div className="ai-section">
            <div className="ai-section-title">
              <span className="workflow-number">05</span>
              Processed Video
            </div>

            <div className="ai-video-wrap">
              <div className="ai-video-label">
                <BrainCircuit size={14} /> YOLO Annotated Output
              </div>

              <video
                ref={resultVideoRef}
                controls
                width="100%"
                src={`${API_URL}/api/ai/result?t=${Date.now()}`}
                className="ai-video-player"
              />
            </div>

            <a
              href={`${API_URL}/api/ai/download`}
              download="tracked_video.mp4"
              className="secondary-button ai-download-btn"
            >
              <Download size={15} />
              Download Processed Video
            </a>
          </div>
        </>
      )}

      {/* Reset */}
      {(uploadStatus !== "idle" || result) && (
        <div className="button-row">
          <button
            className="secondary-button"
            onClick={handleReset}
            type="button"
          >
            <RefreshCw size={15} /> Reset
          </button>
        </div>
      )}
    </section>
  );
}
