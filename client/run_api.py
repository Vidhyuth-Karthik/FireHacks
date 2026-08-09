import sys, os
sys.path.insert(0, r"c:\Users\vidhy\OneDrive\Hackathon\FireHacks\FireHacks\api")
os.environ.setdefault("TTS_BASE_URL", "http://127.0.0.1:8880/v1")
os.environ.setdefault("TTS_RATE_LIMIT_REQUESTS", "5")
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from routers import tts
app = FastAPI()
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
app.include_router(tts.router)
