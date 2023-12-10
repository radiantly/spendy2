import asyncio

import uvicorn
from aiosmtpd.controller import Controller

from server import app
from server.smtp import EmailHandler


async def main():
    controller = Controller(EmailHandler(), hostname="", port=25)
    controller.start()

    config = uvicorn.Config(app, log_level="info")
    server = uvicorn.Server(config)
    await server.serve()


if __name__ == "__main__":
    asyncio.run(main())
