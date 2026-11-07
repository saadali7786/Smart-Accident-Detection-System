
import cv2
import math
import os
import threading
import uuid
from collections import deque

from pathlib import Path

from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from ultralytics import YOLO

if __package__:
    from .accident_analysis import AccidentAnalyzer, AnalysisConfig
    from .backend_forwarder import BackendEventForwarder
else:
    from accident_analysis import AccidentAnalyzer, AnalysisConfig
    from backend_forwarder import BackendEventForwarder

# Initialize API
app = FastAPI(
    title="Smart Accident Detection AI",
    description="AI video processing service",
    version="1.0"
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Project directories
BASE_DIR = Path(__file__).resolve().parent
UPLOAD_DIR = BASE_DIR / "videos"
OUTPUT_DIR = BASE_DIR / "output"
MODEL_PATH = BASE_DIR / "models" / "yolo11n.pt"

UPLOAD_DIR.mkdir(exist_ok=True)
OUTPUT_DIR.mkdir(exist_ok=True)

VIDEO_PATH = UPLOAD_DIR / "uploaded_video.mp4"
UPLOAD_TEMP_PATH = UPLOAD_DIR / "uploaded_video.tmp"
OUTPUT_PATH = OUTPUT_DIR / "tracked_uploaded_video.mp4"

# 100 MB file size limit
MAX_UPLOAD_BYTES = 100 * 1024 * 1024

# Processing state (simple in-memory flag)
processing_state = {
    "is_processing": False,
    "is_uploading": False,
    "progress": 0,
    "total_frames": 0,
    "processed_frames": 0,
    "status": "idle",   # idle | processing | done | error
    "error": None,
    "last_result": None,
}
PROCESSING_LOCK = threading.Lock()
ANALYSIS_CONFIG = AnalysisConfig.from_environment()
AI_FORWARD_CONFIDENCE_THRESHOLD = float(
    os.environ.get("AI_FORWARD_CONFIDENCE_THRESHOLD", "0.8")
)
if (
    not math.isfinite(AI_FORWARD_CONFIDENCE_THRESHOLD)
    or not 0 <= AI_FORWARD_CONFIDENCE_THRESHOLD <= 1
):
    raise ValueError("AI_FORWARD_CONFIDENCE_THRESHOLD must be between 0 and 1")
AI_BACKEND_URL = os.environ.get(
    "AI_BACKEND_URL", "http://127.0.0.1:8080"
)
AI_BACKEND_TIMEOUT_SECONDS = float(
    os.environ.get("AI_BACKEND_TIMEOUT_SECONDS", "0.5")
)
if (
    not math.isfinite(AI_BACKEND_TIMEOUT_SECONDS)
    or AI_BACKEND_TIMEOUT_SECONDS <= 0
):
    raise ValueError("AI_BACKEND_TIMEOUT_SECONDS must be finite and positive")
BACKEND_FORWARDER = BackendEventForwarder(
    AI_BACKEND_URL, timeout_seconds=AI_BACKEND_TIMEOUT_SECONDS
)

# Load YOLO model
model = YOLO(str(MODEL_PATH))

@app.get("/")
def home():
    return {
        "success": True,
        "message": "Smart Accident Detection AI is running"
    }

@app.get("/api/ai/status")
def ai_status():
    return {
        "success": True,
        "service": "Python AI",
        "status": "Online",
        "model": "YOLO11n",
        "processing": processing_state["is_processing"],
        "uploading": processing_state["is_uploading"],
        "processingStatus": processing_state["status"],
        "progress": processing_state["progress"],
    }

# Upload video
@app.post("/api/ai/upload")
async def upload_video(file: UploadFile = File(...)):
    if not file.filename or not file.filename.lower().endswith(
        (".mp4", ".avi", ".mov", ".mkv")
    ):
        raise HTTPException(
            status_code=400,
            detail="Unsupported video format. Use MP4, AVI, MOV or MKV."
        )

    with PROCESSING_LOCK:
        if processing_state["is_processing"] or processing_state["is_uploading"]:
            raise HTTPException(
                status_code=409,
                detail="A video upload or detection is already running. Please wait."
            )
        processing_state["is_uploading"] = True

    # Stream file, enforcing size limit
    written = 0
    try:
        with UPLOAD_TEMP_PATH.open("wb") as buffer:
            while True:
                chunk = await file.read(1024 * 1024)  # 1 MB chunks
                if not chunk:
                    break
                written += len(chunk)
                if written > MAX_UPLOAD_BYTES:
                    raise HTTPException(
                        status_code=413,
                        detail="Video file exceeds the 100 MB limit."
                    )
                buffer.write(chunk)
        if written == 0:
            raise HTTPException(status_code=400, detail="Uploaded video is empty.")
        os.replace(UPLOAD_TEMP_PATH, VIDEO_PATH)
        OUTPUT_PATH.unlink(missing_ok=True)
        processing_state.update({
            "progress": 0,
            "total_frames": 0,
            "processed_frames": 0,
            "status": "idle",
            "error": None,
            "last_result": None,
        })
    except HTTPException:
        UPLOAD_TEMP_PATH.unlink(missing_ok=True)
        raise
    except Exception as exc:
        UPLOAD_TEMP_PATH.unlink(missing_ok=True)
        raise HTTPException(status_code=500, detail=f"Upload failed: {exc}")
    finally:
        with PROCESSING_LOCK:
            processing_state["is_uploading"] = False
        await file.close()

    return {
        "success": True,
        "message": "Video uploaded successfully",
        "filename": VIDEO_PATH.name,
        "sizeBytes": written,
    }

# ─── Detect endpoint ─────────────────────────────────────────────────────────

# Run YOLO vehicle tracking
@app.post("/api/ai/detect")
def detect_vehicles():
    with PROCESSING_LOCK:
        if processing_state["is_processing"] or processing_state["is_uploading"]:
            raise HTTPException(
                status_code=409,
                detail="A video upload or detection is already running."
            )
        if not VIDEO_PATH.exists():
            raise HTTPException(status_code=404, detail="Upload a video first")
        processing_state.update({
            "is_processing": True,
            "status": "processing",
            "progress": 0,
            "total_frames": 0,
            "processed_frames": 0,
            "error": None,
            "last_result": None,
        })

    cap = None
    writer = None
    try:
        OUTPUT_PATH.unlink(missing_ok=True)
        cap = cv2.VideoCapture(str(VIDEO_PATH))
        if not cap.isOpened():
            raise HTTPException(status_code=400, detail="Cannot open uploaded video")

        width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        fps_from_video = float(cap.get(cv2.CAP_PROP_FPS))
        fps_estimated = not math.isfinite(fps_from_video) or fps_from_video <= 0
        fps = 25.0 if fps_estimated else fps_from_video
        total_frames = max(0, int(cap.get(cv2.CAP_PROP_FRAME_COUNT)))
        if width <= 0 or height <= 0:
            raise HTTPException(
                status_code=400,
                detail="Uploaded video has invalid frame dimensions."
            )

        processing_state.update({
            "total_frames": total_frames,
            "error": None,
        })
        writer = cv2.VideoWriter(
            str(OUTPUT_PATH),
            cv2.VideoWriter_fourcc(*"mp4v"),
            fps,
            (width, height),
        )
        if not writer.isOpened():
            raise HTTPException(
                status_code=500,
                detail="Cannot create output video"
            )

        vehicle_classes = [2, 3, 5, 7]
        analyzer = AccidentAnalyzer(ANALYSIS_CONFIG)
        detection_run_id = uuid.uuid4().hex
        track_history = {}
        frame_count = 0
        total_vehicle_detections = 0
        detected_ids = set()

        while True:
            ret, frame = cap.read()
            if not ret:
                break

            results = model.track(
                frame,
                persist=True,
                tracker="bytetrack.yaml",
                classes=vehicle_classes,
                conf=0.30,
                imgsz=320,
                device="cpu",
                verbose=False,
            )
            frame_result = results[0]
            annotated_frame = frame_result.plot()
            detections = {}
            boxes_result = frame_result.boxes

            if boxes_result is not None and len(boxes_result) > 0:
                total_vehicle_detections += len(boxes_result)
                if boxes_result.id is not None:
                    boxes = boxes_result.xywh.cpu().tolist()
                    track_ids = boxes_result.id.int().cpu().tolist()
                    for box, track_id in zip(boxes, track_ids):
                        x, y = box[:2]
                        track_id = int(track_id)
                        detections[track_id] = box
                        detected_ids.add(track_id)
                        points = track_history.setdefault(track_id, deque(maxlen=30))
                        points.append((int(x), int(y)))
                        for point_index in range(1, len(points)):
                            cv2.line(
                                annotated_frame,
                                points[point_index - 1],
                                points[point_index],
                                (0, 255, 0),
                                2,
                            )

            frame_events = analyzer.update(
                frame_count,
                fps,
                (width, height),
                detections,
            )
            for event_index, event in enumerate(frame_events[-3:]):
                color = (
                    (0, 0, 255)
                    if event["classification"] == "suspected_accident"
                    else (0, 191, 255)
                )
                overlay = "{}: {}".format(
                    event["classification_label"], event["reason"]
                )[:110]
                cv2.putText(
                    annotated_frame,
                    overlay,
                    (10, 28 + event_index * 24),
                    cv2.FONT_HERSHEY_SIMPLEX,
                    0.55,
                    color,
                    2,
                )

            writer.write(annotated_frame)
            frame_count += 1
            processing_state["processed_frames"] = frame_count
            if total_frames > 0:
                processing_state["progress"] = min(
                    100, int(frame_count / total_frames * 100)
                )

        if frame_count == 0:
            raise HTTPException(
                status_code=422,
                detail="Uploaded video contains no readable frames."
            )

        analysis = analyzer.results(
            fps,
            fps_estimated=fps_estimated,
            total_vehicle_detections=total_vehicle_detections,
        )
        events = analysis["events"]
        for event in events:
            event["event_id"] = "{}-{}".format(
                detection_run_id, event["event_id"]
            )
            event["id"] = event["event_id"]
        queued_events = sum(
            BACKEND_FORWARDER.submit(event, AI_FORWARD_CONFIDENCE_THRESHOLD)
            for event in events
        )
        result = {
            "success": True,
            "message": "Vehicle tracking and accident-indicator analysis completed",
            "processed_frames": frame_count,
            "total_vehicles_detected": len(detected_ids),
            "total_vehicle_detections": total_vehicle_detections,
            "unique_tracking_ids": len(detected_ids),
            "fps": round(fps, 3),
            "fps_estimated": fps_estimated,
            "videoDurationSeconds": round(frame_count / fps, 3),
            "overall_classification": analysis["overall_classification"],
            "overall_classification_label": analysis["overall_classification_label"],
            "potential_accidents": events,
            "potential_accident_count": len(events),
            "suspected_accident_count": analysis["suspected_accident_count"],
            "confirmed_accident_count": analysis["confirmed_accident_count"],
            "accident_analysis": analysis,
            "queued_for_backend": queued_events,
            "forwarding_threshold": AI_FORWARD_CONFIDENCE_THRESHOLD,
            "forwarding_status": BACKEND_FORWARDER.status(),
            "forwarding_note": (
                "Only suspected-or-higher classifications, or potential events "
                "with a numeric confidence score meeting the configured threshold, "
                "are submitted. Video-only indicators remain unconfirmed."
            ),
            "output": "/api/ai/result",
            "note": analysis["note"],
        }
        processing_state.update({
            "status": "done",
            "progress": 100,
            "last_result": result,
        })
        return result
    except HTTPException as exc:
        processing_state.update({
            "status": "error",
            "error": str(exc.detail),
        })
        raise
    except Exception as exc:
        processing_state.update({
            "status": "error",
            "error": str(exc),
        })
        raise HTTPException(status_code=500, detail=f"Detection failed: {exc}")
    finally:
        try:
            if cap is not None:
                cap.release()
            if writer is not None:
                writer.release()
            predictor = getattr(model, "predictor", None)
            for tracker in getattr(predictor, "trackers", ()):
                tracker.reset()
        finally:
            with PROCESSING_LOCK:
                processing_state["is_processing"] = False


@app.get("/api/ai/processing-status")
def get_processing_status():
    """Poll this endpoint while detection is running to get live progress."""
    return {
        "success": True,
        "isProcessing": processing_state["is_processing"],
        "isUploading": processing_state["is_uploading"],
        "status": processing_state["status"],
        "progress": processing_state["progress"],
        "processedFrames": processing_state["processed_frames"],
        "totalFrames": processing_state["total_frames"],
        "error": processing_state["error"],
    }


@app.get("/api/ai/analysis")
def get_accident_analysis():
    result = processing_state["last_result"]
    if result is None:
        raise HTTPException(
            status_code=404,
            detail="No accident analysis is available. Run detection first."
        )
    return {
        "success": True,
        "analysis": result["accident_analysis"],
    }


@app.get("/api/ai/backend-forwarding-status")
def get_backend_forwarding_status():
    return {
        "success": True,
        "confidenceThreshold": AI_FORWARD_CONFIDENCE_THRESHOLD,
        "status": BACKEND_FORWARDER.status(),
    }


# View processed video
@app.get("/api/ai/result")
def get_result():

    if not OUTPUT_PATH.exists():
        raise HTTPException(
            status_code=404,
            detail="No processed video available. Run detection first."
        )

    return FileResponse(
        OUTPUT_PATH,
        media_type="video/mp4",
        filename="tracked_uploaded_video.mp4",
        headers={"Accept-Ranges": "bytes"},
    )
