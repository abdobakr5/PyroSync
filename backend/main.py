"""
PyroSync Backend API (FastAPI Clean Architecture Entrypoint)
"""
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from presentation.routes import router

app = FastAPI(
    title="PyroSync API",
    version="3.0.0",
    description="Clean Architecture FastAPI serving NASA MODIS & VIIRS Gold harmonization datasets.",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(router)
