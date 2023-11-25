from fastapi import FastAPI

from .api import api

app = FastAPI(openapi_url=None)

app.mount("/api", api)
