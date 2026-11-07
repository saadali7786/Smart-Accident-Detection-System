
import math
import cv2
from ultralytics import YOLO
from pathlib import Path
from collections import defaultdict, deque

if __package__:
    from .accident_analysis import AccidentAnalyzer, AnalysisConfig
else:
    from accident_analysis import AccidentAnalyzer, AnalysisConfig

# Project directories
BASE_DIR = Path(__file__).resolve().parent
VIDEO_DIR = BASE_DIR / "videos"
OUTPUT_DIR = BASE_DIR / "output"
MODEL_DIR = BASE_DIR / "models"

OUTPUT_DIR.mkdir(exist_ok=True)

# Load YOLO model
model_path = MODEL_DIR / "yolo11n.pt"

if not model_path.exists():
    print("Downloading YOLO model...")
    model = YOLO("yolo11n.pt")
    model.save(str(model_path))
else:
    model = YOLO(str(model_path))

# Video file
video_path = VIDEO_DIR / "traffic.mp4"

if not video_path.exists():
    print("ERROR: traffic.mp4 not found in AI/videos/")
    raise SystemExit(1)

cap = cv2.VideoCapture(str(video_path))

if not cap.isOpened():
    print("ERROR: Cannot open video")
    raise SystemExit(1)

# Video properties
width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
fps = cap.get(cv2.CAP_PROP_FPS)
fps_estimated = not math.isfinite(fps) or fps <= 0

if fps_estimated:
    fps = 25
if width <= 0 or height <= 0:
    cap.release()
    raise RuntimeError("The input video has invalid frame dimensions.")

output_path = OUTPUT_DIR / "tracked_vehicles.mp4"

fourcc = cv2.VideoWriter_fourcc(*"mp4v")
writer = cv2.VideoWriter(
    str(output_path),
    fourcc,
    fps,
    (width, height)
)
if not writer.isOpened():
    cap.release()
    raise RuntimeError("Cannot create output video: {}".format(output_path))

# Vehicle classes: car, motorcycle, bus, truck
vehicle_classes = [2, 3, 5, 7]

# Store last 30 positions of each vehicle
track_history = defaultdict(lambda: deque(maxlen=30))
analyzer = AccidentAnalyzer(AnalysisConfig.from_environment())
frame_count = 0
total_vehicle_detections = 0
detected_ids = set()

print("Starting vehicle tracking...")
print("Processing on CPU...")

try:
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
            verbose=False
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
                    track_history[track_id].append((int(x), int(y)))

                    points = list(track_history[track_id])
                    for index in range(1, len(points)):
                        cv2.line(
                            annotated_frame,
                            points[index - 1],
                            points[index],
                            (0, 255, 0),
                            2
                        )

        events = analyzer.update(
            frame_count,
            fps,
            (width, height),
            detections
        )
        for event_index, event in enumerate(events[-3:]):
            color = (
                (0, 0, 255)
                if event["classification"] == "suspected_accident"
                else (0, 191, 255)
            )
            text = "{}: {}".format(
                event["classification_label"], event["reason"]
            )[:110]
            cv2.putText(
                annotated_frame,
                text,
                (10, 28 + event_index * 24),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.55,
                color,
                2
            )

        writer.write(annotated_frame)
        frame_count += 1
        cv2.imshow("Smart Accident Detection - Vehicle Tracking", annotated_frame)
        if cv2.waitKey(1) & 0xFF == ord("q"):
            break
finally:
    cap.release()
    writer.release()
    cv2.destroyAllWindows()

if frame_count == 0:
    raise RuntimeError("The input video contains no readable frames.")

analysis = analyzer.results(
    fps,
    fps_estimated=fps_estimated,
    total_vehicle_detections=total_vehicle_detections
)

print("Tracking completed!")
print("Output saved:", output_path)
print("Total vehicle detections:", total_vehicle_detections)
print("Unique tracking IDs:", len(detected_ids))
print("Overall classification:", analysis["overall_classification_label"])
print("Potential events:", analysis["potential_accident_count"])
print("Suspected events:", analysis["suspected_accident_count"])
for event in analysis["events"]:
    print(
        event["timestamp"],
        event["classification_label"],
        "vehicles={}".format(event["involved_vehicle_ids"]),
        event["reason"]
    )
print(analysis["note"])
