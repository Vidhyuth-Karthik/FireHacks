# Entry point for the FastAPI app.
#
# Run it with:
#     cd hackathon-starter-kit/api
#     pip install -r requirements.txt
#     uvicorn main:app --reload
#
# This API is standalone - it does NOT serve the frontend. It's meant
# to be deployed as its own Docker Space on Hugging Face (see the
# Dockerfile and README.md in this folder), with the "client" folder
# deployed separately as a Static Space.

import os

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from database import init_db
from routers import ai, auth, emp

app = FastAPI(title="Hackathon Starter Kit API")

# The frontend now runs on a different origin (different port locally,
# a different *.hf.space domain in production), so the browser enforces
# CORS on every request it makes here. List the frontend origin(s)
# allowed to call this API - set CORS_ORIGINS as a comma-separated
# Space secret/variable in production, e.g.
# "https://your-username-your-client-space.hf.space".
CORS_ORIGINS = os.environ.get(
    "CORS_ORIGINS", "https://hackathon-kit-seven.vercel.app,http://localhost:5500,http://127.0.0.1:5500"
).split(",")

app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_credentials=True,  # required so the session cookie is sent/received
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
def on_startup():
    # Create the database tables (if they don't exist yet) as soon as
    # the app starts.
    print("Initializing database...")
    init_db()


# Register routers here. Add new ones the same way as you build out
# more features, e.g. app.include_router(chat.router).
app.include_router(auth.router)
app.include_router(ai.router)
app.include_router(emp.router)
