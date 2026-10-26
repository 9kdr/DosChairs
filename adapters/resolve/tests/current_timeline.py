"""One Resolve-shaped snapshot of an open timeline. Not a live Studio session."""

CURRENT_TIMELINE = {
    "project_name": "Demo",
    "name": "Rough cut",
    "unique_id": "tl-demo-rough",
    "start_frame": 86400,
    "frame_rate": "24",
    "tracks": [
        {
            "track_type": "video",
            "index": 1,
            "name": "V1",
            "items": [
                {
                    "unique_id": "clip-interview",
                    "name": "Interview",
                    "start": 86400,
                    "end": 86448,
                    "source_start_frame": 100,
                    "source_end_frame": 196,
                    "file_path": "/media/interview.mov",
                    "fusion_comp": "ignore",
                    "speed": 2.0,
                }
            ],
        },
        {
            "track_type": "audio",
            "index": 1,
            "name": "A1",
            "items": [
                {
                    "unique_id": "clip-interview-audio",
                    "name": "Interview audio",
                    "start": 86400,
                    "end": 86448,
                    "source_start_frame": 100,
                    "source_end_frame": 148,
                    "file_path": "/media/interview.mov",
                }
            ],
        },
        {
            "track_type": "subtitle",
            "index": 1,
            "name": "Captions",
            "items": [
                {
                    "unique_id": "sub-hello",
                    "name": "Hello",
                    "start": 86412,
                    "end": 86436,
                    "source_start_frame": 0,
                    "source_end_frame": 24,
                    "file_path": None,
                }
            ],
        },
    ],
    "markers": {
        86448: {
            "color": "Blue",
            "duration": 1,
            "note": "room tone",
            "name": "Room tone",
            "customData": "ignore-me",
        },
        86410: {
            "color": "Green",
            "duration": 1.0,
            "note": "",
            "name": "Hook",
            "customData": "",
        },
        86420: {
            "color": "Beat",
            "duration": 8,
            "note": "opener",
            "name": "Open",
            "customData": "",
        },
    },
}
