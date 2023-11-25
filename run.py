import asyncio

import uvicorn

from server import app


async def main():
    config = uvicorn.Config(app, log_level="info", reload=True)
    server = uvicorn.Server(config)
    await server.serve()


if __name__ == "__main__":
    asyncio.run(main())
