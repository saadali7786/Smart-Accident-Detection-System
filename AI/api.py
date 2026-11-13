
import cv2
import numpy as np
import math
import os
import threading
import uuid
from pathlib import Path
import subprocess
from fastapi import FastAPI, UploadFile, File, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from ultralytics import YOLO

if __package__:
    from .accident_analysis import AccidentAnalyzer, AnalysisConfig
    from .backend_forwarder import BackendEventForwarder
else:
    from accident_analysis import AccidentAnalyzer, AnalysisConfig
    from backend_forwarder import BackendEventForwarder


# ============================================================
# FASTAPI INITIALIZATION
# ============================================================

app = FastAPI(
    title="Smart Accident Detection AI",
    description="AI video processing service",
    version="1.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://localhost:5174",
        "http://127.0.0.1:5174",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ============================================================
# PROJECT DIRECTORIES
# ============================================================

BASE_DIR = Path(__file__).resolve().parent

UPLOAD_DIR = BASE_DIR / "videos"
OUTPUT_DIR = BASE_DIR / "output"
MODEL_PATH = BASE_DIR / "models" / "yolo11n.pt"

UPLOAD_DIR.mkdir(exist_ok=True)
OUTPUT_DIR.mkdir(exist_ok=True)

VIDEO_PATH = UPLOAD_DIR / "uploaded_video.mp4"
UPLOAD_TEMP_PATH = UPLOAD_DIR / "uploaded_video.tmp"
OUTPUT_PATH = OUTPUT_DIR / "tracked_uploaded_video.mp4"
BROWSER_OUTPUT_PATH = OUTPUT_DIR / "tracked_uploaded_video_h264.mp4"

MAX_UPLOAD_BYTES = 100 * 1024 * 1024


# ============================================================
# PROCESSING STATE
# ============================================================

processing_state = {
    "is_processing": False,
    "is_uploading": False,
    "progress": 0,
    "total_frames": 0,
    "processed_frames": 0,
    "status": "idle",
    "error": None,
    "last_result": None,
}

PROCESSING_LOCK = threading.Lock()


# ============================================================
# LIVE WEBCAM STATE
# ============================================================

LIVE_FPS = 2.0

MAX_LIVE_FRAME_BYTES = 2 * 1024 * 1024
MAX_LIVE_FRAME_DIMENSION = 1280

LIVE_SESSION_LOCK = threading.Lock()
LIVE_FRAME_LOCK = threading.Lock()

live_state = {
    "active": False,
    "stopping": False,
    "session_id": None,
    "frame_index": 0,
    "processed_frames": 0,
    "started_at": None,
    "analyzer": None,
    "width": 0,
    "height": 0,
    "total_vehicle_detections": 0,
    "detected_ids": set(),
}


# ============================================================
# AI CONFIGURATION
# ============================================================

ANALYSIS_CONFIG = AnalysisConfig.from_environment()

AI_FORWARD_CONFIDENCE_THRESHOLD = float(
    os.environ.get(
        "AI_FORWARD_CONFIDENCE_THRESHOLD",
        "0.8",
    )
)

if (
    not math.isfinite(AI_FORWARD_CONFIDENCE_THRESHOLD)
    or not 0 <= AI_FORWARD_CONFIDENCE_THRESHOLD <= 1
):
    raise ValueError(
        "AI_FORWARD_CONFIDENCE_THRESHOLD must be between 0 and 1"
    )


AI_BACKEND_URL = os.environ.get(
    "AI_BACKEND_URL",
    "http://127.0.0.1:8080",
)

AI_BACKEND_TIMEOUT_SECONDS = float(
    os.environ.get(
        "AI_BACKEND_TIMEOUT_SECONDS",
        "0.5",
    )
)

if (
    not math.isfinite(AI_BACKEND_TIMEOUT_SECONDS)
    or AI_BACKEND_TIMEOUT_SECONDS <= 0
):
    raise ValueError(
        "AI_BACKEND_TIMEOUT_SECONDS must be finite and positive"
    )


BACKEND_FORWARDER = BackendEventForwarder(
    AI_BACKEND_URL,
    timeout_seconds=AI_BACKEND_TIMEOUT_SECONDS,
)


# ============================================================
# YOLO MODEL
# ============================================================

model = YOLO(str(MODEL_PATH))


def reset_yolo_trackers():
    """Reset ByteTrack state before a new inference session."""

    predictor = getattr(model, "predictor", None)

    for tracker in getattr(predictor, "trackers", ()):
        tracker.reset()


# ============================================================
# HOME
# ============================================================

@app.get("/")
def home():
    return {
        "success": True,
        "message": "Smart Accident Detection AI is running",
    }


# ============================================================
# AI STATUS
# ============================================================

@app.get("/api/ai/status")
def ai_status():

    with PROCESSING_LOCK:
        processing = processing_state["is_processing"]
        uploading = processing_state["is_uploading"]
        processing_status = processing_state["status"]
        progress = processing_state["progress"]

    with LIVE_SESSION_LOCK:
        live_active = live_state["active"]
        live_stopping = live_state["stopping"]

        live_info = {
            "active": live_active,
            "stopping": live_stopping,
            "sessionId": live_state["session_id"],
            "processedFrames": live_state["processed_frames"],
            "vehicleCount": len(live_state["detected_ids"]),
            "width": live_state["width"],
            "height": live_state["height"],
        }

    return {
        "success": True,
        "service": "Python AI",
        "status": "Online",
        "model": "YOLO11n",
        "processing": processing,
        "uploading": uploading,
        "processingStatus": processing_status,
        "progress": progress,
        "liveMonitoring": live_info,
    }


# ============================================================
# VIDEO UPLOAD
# ============================================================

@app.post("/api/ai/upload")
async def upload_video(file: UploadFile = File(...)):

    if not file.filename or not file.filename.lower().endswith(
        (".mp4", ".avi", ".mov", ".mkv")
    ):
        await file.close()

        raise HTTPException(
            status_code=400,
            detail="Unsupported video format. Use MP4, AVI, MOV or MKV.",
        )

    with PROCESSING_LOCK:

        with LIVE_SESSION_LOCK:

            if live_state["active"] or live_state["stopping"]:
                raise HTTPException(
                    status_code=409,
                    detail="Stop live monitoring before uploading a video.",
                )

        if (
            processing_state["is_processing"]
            or processing_state["is_uploading"]
        ):
            raise HTTPException(
                status_code=409,
                detail="A video upload or detection is already running.",
            )

        processing_state["is_uploading"] = True

    written = 0

    try:

        with UPLOAD_TEMP_PATH.open("wb") as buffer:

            while True:

                chunk = await file.read(1024 * 1024)

                if not chunk:
                    break

                written += len(chunk)

                if written > MAX_UPLOAD_BYTES:
                    raise HTTPException(
                        status_code=413,
                        detail="Video file exceeds the 100 MB limit.",
                    )

                buffer.write(chunk)

        if written == 0:
            raise HTTPException(
                status_code=400,
                detail="Uploaded video is empty.",
            )

        os.replace(
            UPLOAD_TEMP_PATH,
            VIDEO_PATH,
        )

        OUTPUT_PATH.unlink(missing_ok=True)
        BROWSER_OUTPUT_PATH.unlink(missing_ok=True)

        processing_state.update({
            "progress": 0,
            "total_frames": 0,
            "processed_frames": 0,
            "status": "idle",
            "error": None,
            "last_result": None,
        })

        return {
            "success": True,
            "message": "Video uploaded successfully",
            "filename": VIDEO_PATH.name,
            "sizeBytes": written,
        }

    except HTTPException:
        UPLOAD_TEMP_PATH.unlink(missing_ok=True)
        raise

    except Exception as exc:
        UPLOAD_TEMP_PATH.unlink(missing_ok=True)

        raise HTTPException(
            status_code=500,
            detail=f"Upload failed: {exc}",
        )

    finally:

        await file.close()

        with PROCESSING_LOCK:
            processing_state["is_uploading"] = False


# ============================================================
# RECORDED VIDEO DETECTION
# ============================================================

@app.post("/api/ai/detect")
def detect_vehicles():

    with PROCESSING_LOCK:

        with LIVE_SESSION_LOCK:

            if live_state["active"] or live_state["stopping"]:
                raise HTTPException(
                    status_code=409,
                    detail=(
                        "Stop live monitoring before starting "
                        "recorded-video detection."
                    ),
                )

        if (
            processing_state["is_processing"]
            or processing_state["is_uploading"]
        ):
            raise HTTPException(
                status_code=409,
                detail="A video upload or detection is already running.",
            )

        if not VIDEO_PATH.exists():
            raise HTTPException(
                status_code=404,
                detail="Upload a video first.",
            )

        processing_state.update({
            "is_processing": True,
            "status": "processing",
            "progress": 0,
            "total_frames": 0,
            "processed_frames": 0,
            "error": None,
            "last_result": None,
        })

    LIVE_FRAME_LOCK.acquire()

    cap = None
    writer = None

    try:

        reset_yolo_trackers()

        OUTPUT_PATH.unlink(missing_ok=True)

        cap = cv2.VideoCapture(str(VIDEO_PATH))

        if not cap.isOpened():
            raise HTTPException(
                status_code=400,
                detail="Cannot open uploaded video.",
            )

        width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))

        fps_from_video = float(
            cap.get(cv2.CAP_PROP_FPS)
        )

        fps_estimated = (
            not math.isfinite(fps_from_video)
            or fps_from_video <= 0
        )

        fps = 25.0 if fps_estimated else fps_from_video

        total_frames = max(
            0,
            int(cap.get(cv2.CAP_PROP_FRAME_COUNT)),
        )

        if width <= 0 or height <= 0:
            raise HTTPException(
                status_code=400,
                detail="Uploaded video has invalid frame dimensions.",
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
                detail="Cannot create output video.",
            )

        vehicle_classes = [2, 3, 5, 7]

        analyzer = AccidentAnalyzer(ANALYSIS_CONFIG)

        detection_run_id = uuid.uuid4().hex

        frame_count = 0
        total_vehicle_detections = 0
        detected_ids = set()

        # ----------------------------------------------------
        # PROCESS VIDEO FRAMES
        # ----------------------------------------------------

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

            # Start with original frame to avoid YOLO label backgrounds.
            annotated_frame = frame.copy()

            detections = {}
            track_boxes = {}

            boxes_result = frame_result.boxes

            if boxes_result is not None and len(boxes_result) > 0:

                total_vehicle_detections += len(boxes_result)

                if boxes_result.id is not None:

                    boxes = boxes_result.xywh.cpu().tolist()
                    boxes_xyxy = boxes_result.xyxy.cpu().tolist()
                    track_ids = boxes_result.id.int().cpu().tolist()

                    for box, box_xyxy, track_id in zip(
                        boxes,
                        boxes_xyxy,
                        track_ids,
                    ):

                        track_id = int(track_id)

                        detections[track_id] = box
                        track_boxes[track_id] = box_xyxy

                        detected_ids.add(track_id)

            # Analyze current frame.
            frame_events = analyzer.update(
                frame_count,
                fps,
                (width, height),
                detections,
            )

            # ------------------------------------------------
            # COLLISION RISK TRACK IDS
            # ------------------------------------------------

            # Only suspected events receive red boxes.
            # Potential-only events remain green.

            risk_track_ids = set()

            for event in frame_events:

                if event.get("classification") != "suspected_accident":
                    continue

                for track_id in event.get("trackIds", []):

                    try:
                        risk_track_ids.add(int(track_id))
                    except (TypeError, ValueError):
                        continue

            # ------------------------------------------------
            # DRAW CLEAN VEHICLE BOXES
            # ------------------------------------------------

            for track_id, box in track_boxes.items():

                x1, y1, x2, y2 = map(int, box)

                collision_risk = track_id in risk_track_ids

                # OpenCV uses BGR colors.
                # Red = suspected collision.
                # Green = normal/potential-only vehicle.

                color = (
                    (0, 0, 255)
                    if collision_risk
                    else (0, 255, 0)
                )

                cv2.rectangle(
                    annotated_frame,
                    (x1, y1),
                    (x2, y2),
                    color,
                    2,
                )

                # Compact ID label without background.
                label = f"ID {track_id}"

                label_y = max(14, y1 - 5)

                cv2.putText(
                    annotated_frame,
                    label,
                    (x1, label_y),
                    cv2.FONT_HERSHEY_SIMPLEX,
                    0.35,
                    color,
                    1,
                    cv2.LINE_AA,
                )

            # Save annotated frame.
            writer.write(annotated_frame)

            frame_count += 1

            processing_state["processed_frames"] = frame_count

            if total_frames > 0:

                processing_state["progress"] = min(
                    100,
                    int(frame_count / total_frames * 100),
                )

        if frame_count == 0:
            raise HTTPException(
                status_code=422,
                detail="Uploaded video contains no readable frames.",
            )
            
                # Close the MP4V writer before FFmpeg reads the file.
        if writer is not None:
            writer.release()
            writer = None

        if cap is not None:
            cap.release()
            cap = None

        # Convert YOLO output into browser-compatible H.264 MP4.
        BROWSER_OUTPUT_PATH.unlink(missing_ok=True)

        conversion = subprocess.run(
            [
                "ffmpeg",
                "-y",
                "-i", str(OUTPUT_PATH),
                "-c:v", "libx264",
                "-preset", "ultrafast",
                "-crf", "23",
                "-pix_fmt", "yuv420p",
                "-movflags", "+faststart",
                "-an",
                str(BROWSER_OUTPUT_PATH),
            ],
            capture_output=True,
            text=True,
        )

        if conversion.returncode != 0:
            raise RuntimeError(
                "H.264 video conversion failed: "
                + conversion.stderr[-2000:]
            )

        if not BROWSER_OUTPUT_PATH.exists():
            raise RuntimeError("H.264 output video was not created.")

        # ----------------------------------------------------
        # GENERATE ACCIDENT ANALYSIS
        # ----------------------------------------------------

        analysis = analyzer.results(
            fps,
            fps_estimated=fps_estimated,
            total_vehicle_detections=total_vehicle_detections,
        )

        events = analysis["events"]

        for event in events:

            event["event_id"] = "{}-{}".format(
                detection_run_id,
                event["event_id"],
            )

            event["id"] = event["event_id"]

        # ----------------------------------------------------
        # FORWARD ELIGIBLE EVENTS TO C++ BACKEND
        # ----------------------------------------------------

        queued_events = sum(
            BACKEND_FORWARDER.submit(
                event,
                AI_FORWARD_CONFIDENCE_THRESHOLD,
            )
            for event in events
        )

        result = {
            "success": True,
            "message": (
                "Vehicle tracking and accident-indicator "
                "analysis completed"
            ),
            "processed_frames": frame_count,
            "total_vehicles_detected": len(detected_ids),
            "total_vehicle_detections": total_vehicle_detections,
            "unique_tracking_ids": len(detected_ids),
            "fps": round(fps, 3),
            "fps_estimated": fps_estimated,
            "videoDurationSeconds": round(
                frame_count / fps,
                3,
            ),
            "overall_classification": analysis[
                "overall_classification"
            ],
            "overall_classification_label": analysis[
                "overall_classification_label"
            ],
            "potential_accidents": events,
            "potential_accident_count": len(events),
            "suspected_accident_count": analysis[
                "suspected_accident_count"
            ],
            "confirmed_accident_count": analysis[
                "confirmed_accident_count"
            ],
            "accident_analysis": analysis,
            "queued_for_backend": queued_events,
            "forwarding_threshold": (
                AI_FORWARD_CONFIDENCE_THRESHOLD
            ),
            "forwarding_status": BACKEND_FORWARDER.status(),
            "forwarding_note": (
                "Only suspected-or-higher classifications, or "
                "potential events with a numeric confidence score "
                "meeting the configured threshold, are submitted. "
                "Video-only indicators remain unconfirmed."
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

        raise HTTPException(
            status_code=500,
            detail=f"Detection failed: {exc}",
        )

    finally:

        try:

            if cap is not None:
                cap.release()

            if writer is not None:
                writer.release()

            reset_yolo_trackers()

        finally:

            LIVE_FRAME_LOCK.release()

            with PROCESSING_LOCK:
                processing_state["is_processing"] = False


# ============================================================
# PROCESSING STATUS
# ============================================================

@app.get("/api/ai/processing-status")
def get_processing_status():

    with PROCESSING_LOCK:

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


# ============================================================
# ACCIDENT ANALYSIS
# ============================================================

@app.get("/api/ai/analysis")
def get_accident_analysis():

    with PROCESSING_LOCK:
        result = processing_state["last_result"]

    if result is None:
        raise HTTPException(
            status_code=404,
            detail="No accident analysis is available. Run detection first.",
        )

    return {
        "success": True,
        "analysis": result["accident_analysis"],
    }


# ============================================================
# BACKEND FORWARDING STATUS
# ============================================================

@app.get("/api/ai/backend-forwarding-status")
def get_backend_forwarding_status():

    return {
        "success": True,
        "confidenceThreshold": AI_FORWARD_CONFIDENCE_THRESHOLD,
        "status": BACKEND_FORWARDER.status(),
    }


# ============================================================
# LIVE MONITORING START
# ============================================================

@app.post("/api/ai/live/start")
def start_live_monitoring():

    with PROCESSING_LOCK:

        with LIVE_SESSION_LOCK:

            if (
                processing_state["is_processing"]
                or processing_state["is_uploading"]
            ):
                raise HTTPException(
                    status_code=409,
                    detail="Stop recorded-video processing first.",
                )

            if live_state["stopping"]:
                raise HTTPException(
                    status_code=409,
                    detail="Previous live session is still stopping.",
                )

            if live_state["active"]:
                raise HTTPException(
                    status_code=409,
                    detail="Live monitoring is already active.",
                )

            with LIVE_FRAME_LOCK:

                reset_yolo_trackers()

                session_id = uuid.uuid4().hex

                live_state.update({
                    "active": True,
                    "stopping": False,
                    "session_id": session_id,
                    "frame_index": 0,
                    "processed_frames": 0,
                    "started_at": None,
                    "analyzer": AccidentAnalyzer(
                        ANALYSIS_CONFIG
                    ),
                    "width": 0,
                    "height": 0,
                    "total_vehicle_detections": 0,
                    "detected_ids": set(),
                })

    return {
        "success": True,
        "message": "Live monitoring session started.",
        "session_id": session_id,
        "fps": LIVE_FPS,
        "model": "YOLO11n",
        "note": (
            "Video-only events are not automatically confirmed."
        ),
    }


# ============================================================
# LIVE FRAME PROCESSING
# ============================================================

@app.post("/api/ai/live/frame")
async def process_live_frame(
    request: Request,
    session_id: str,
):

    frame_bytes = await request.body()

    if not frame_bytes:
        raise HTTPException(
            status_code=400,
            detail="Empty frame received.",
        )

    if len(frame_bytes) > MAX_LIVE_FRAME_BYTES:
        raise HTTPException(
            status_code=413,
            detail="Live frame exceeds 2 MB.",
        )

    if not request.headers.get(
        "content-type",
        "",
    ).startswith("image/jpeg"):

        raise HTTPException(
            status_code=415,
            detail="Send frames using image/jpeg content type.",
        )

    frame_array = np.frombuffer(
        frame_bytes,
        dtype=np.uint8,
    )

    frame = cv2.imdecode(
        frame_array,
        cv2.IMREAD_COLOR,
    )

    if frame is None:
        raise HTTPException(
            status_code=400,
            detail="Invalid JPEG frame.",
        )

    height, width = frame.shape[:2]

    if (
        width < 160
        or height < 120
        or max(width, height) > MAX_LIVE_FRAME_DIMENSION
    ):

        raise HTTPException(
            status_code=400,
            detail=(
                "Frame dimensions must be at least 160x120 "
                "and no larger than 1280 pixels."
            ),
        )

    with PROCESSING_LOCK:

        with LIVE_SESSION_LOCK:

            if not live_state["active"]:
                raise HTTPException(
                    status_code=409,
                    detail="No active live monitoring session.",
                )

            if session_id != live_state["session_id"]:
                raise HTTPException(
                    status_code=409,
                    detail="Invalid or expired live session.",
                )

            LIVE_FRAME_LOCK.acquire()

            session = live_state

    try:

        if (
            not session["active"]
            or session["session_id"] != session_id
        ):

            raise HTTPException(
                status_code=409,
                detail="Live monitoring session has stopped.",
            )

        results = model.track(
            frame,
            persist=True,
            tracker="bytetrack.yaml",
            classes=[2, 3, 5, 7],
            conf=0.30,
            imgsz=320,
            device="cpu",
            verbose=False,
        )

        frame_result = results[0]
        boxes_result = frame_result.boxes

        detections = {}
        tracked_vehicles = []

        if boxes_result is not None and len(boxes_result) > 0:

            session["total_vehicle_detections"] += len(
                boxes_result
            )

            if boxes_result.id is not None:

                boxes = boxes_result.xywh.cpu().tolist()
                track_ids = boxes_result.id.int().cpu().tolist()

                for box, track_id in zip(boxes, track_ids):

                    track_id = int(track_id)

                    detections[track_id] = box

                    session["detected_ids"].add(track_id)

                    tracked_vehicles.append({
                        "track_id": track_id,
                        "bbox_xywh": [
                            round(float(value), 2)
                            for value in box[:4]
                        ],
                    })

        frame_index = session["frame_index"]

        session["analyzer"].update(
            frame_index,
            LIVE_FPS,
            (width, height),
            detections,
        )

        session["frame_index"] += 1
        session["processed_frames"] += 1

        session["width"] = width
        session["height"] = height

        analysis = session["analyzer"].results(
            LIVE_FPS,
            total_vehicle_detections=(
                session["total_vehicle_detections"]
            ),
        )

        queued_events = 0

        if session["active"]:

            for event in analysis["events"]:

                outgoing_event = dict(event)

                outgoing_event["event_id"] = (
                    f"LIVE-{session_id}-{event['event_id']}"
                )

                outgoing_event["id"] = (
                    outgoing_event["event_id"]
                )

                if BACKEND_FORWARDER.submit(
                    outgoing_event,
                    AI_FORWARD_CONFIDENCE_THRESHOLD,
                ):
                    queued_events += 1

        return {
            "success": True,
            "session_id": session_id,
            "frame_index": frame_index,
            "processed_frames": session["processed_frames"],
            "vehicle_count": len(
                session["detected_ids"]
            ),
            "total_vehicle_detections": (
                session["total_vehicle_detections"]
            ),
            "tracked_vehicles": tracked_vehicles,
            "events": analysis["events"],
            "overall_classification": (
                analysis["overall_classification"]
            ),
            "overall_classification_label": (
                analysis["overall_classification_label"]
            ),
            "potential_accident_count": (
                analysis["potential_accident_count"]
            ),
            "suspected_accident_count": (
                analysis["suspected_accident_count"]
            ),
            "confirmed_accident_count": (
                analysis["confirmed_accident_count"]
            ),
            "queued_for_backend": queued_events,
            "forwarding_status": BACKEND_FORWARDER.status(),
            "note": analysis["note"],
        }

    finally:
        LIVE_FRAME_LOCK.release()


# ============================================================
# LIVE MONITORING STOP
# ============================================================

@app.post("/api/ai/live/stop")
def stop_live_monitoring(session_id: str):

    with PROCESSING_LOCK:

        with LIVE_SESSION_LOCK:

            if live_state["stopping"]:
                raise HTTPException(
                    status_code=409,
                    detail="Live monitoring is already stopping.",
                )

            if not live_state["active"]:
                raise HTTPException(
                    status_code=409,
                    detail="No active live monitoring session.",
                )

            if session_id != live_state["session_id"]:
                raise HTTPException(
                    status_code=409,
                    detail="Invalid or expired live session.",
                )

            live_state["active"] = False
            live_state["stopping"] = True

            stopped_session_id = session_id

    with LIVE_FRAME_LOCK:
        reset_yolo_trackers()

    with PROCESSING_LOCK:

        with LIVE_SESSION_LOCK:

            if (
                live_state["session_id"] == stopped_session_id
                and live_state["stopping"]
            ):

                processed_frames = (
                    live_state["processed_frames"]
                )

                unique_vehicles = len(
                    live_state["detected_ids"]
                )

                total_detections = (
                    live_state["total_vehicle_detections"]
                )

                live_state.update({
                    "active": False,
                    "stopping": False,
                    "session_id": None,
                    "frame_index": 0,
                    "processed_frames": 0,
                    "started_at": None,
                    "analyzer": None,
                    "width": 0,
                    "height": 0,
                    "total_vehicle_detections": 0,
                    "detected_ids": set(),
                })

            else:

                raise HTTPException(
                    status_code=409,
                    detail=(
                        "Live session state changed during shutdown."
                    ),
                )

    return {
        "success": True,
        "message": "Live monitoring stopped successfully.",
        "session_id": stopped_session_id,
        "processed_frames": processed_frames,
        "unique_vehicles": unique_vehicles,
        "total_vehicle_detections": total_detections,
        "note": (
            "Visual indicators are not independent accident verification."
        ),
    }


# ============================================================
# PROCESSED VIDEO RESULT
# ============================================================

@app.get("/api/ai/result")
def get_result():
    if not BROWSER_OUTPUT_PATH.exists():
        raise HTTPException(
            status_code=404,
            detail="Processed H.264 video not available. Run detection first.",
        )

    return FileResponse(
        path=BROWSER_OUTPUT_PATH,
        media_type="video/mp4",
        headers={
            "Accept-Ranges": "bytes",
            "Content-Disposition": "inline",
        },
    )


@app.get("/api/ai/download")
def download_result():
    if not BROWSER_OUTPUT_PATH.exists():
        raise HTTPException(
            status_code=404,
            detail="Processed video not available. Run detection first.",
        )

    return FileResponse(
        path=BROWSER_OUTPUT_PATH,
        media_type="video/mp4",
        filename="YOLO_processed_video.mp4",
    )
