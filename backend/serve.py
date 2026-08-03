"""Container entrypoint: uvicorn on a dual-stack (IPv4 + IPv6) socket.

Railway's public edge reaches the container over IPv6 while its deploy
healthcheck probes over IPv4. uvicorn's --host can only serve one stack:
asyncio sets IPV6_V6ONLY on every AF_INET6 listener, so `--host ::` loses
IPv4 and `--host 0.0.0.0` loses IPv6. Building the socket with
dualstack_ipv6=True and handing it to uvicorn serves both.

Local dev keeps using the CLI: `uvicorn app.main:create_app --factory`.
"""

import os
import socket

import uvicorn


def main() -> None:
    port = int(os.environ.get("PORT", "8000"))
    sock = socket.create_server(
        ("", port), family=socket.AF_INET6, dualstack_ipv6=True
    )
    config = uvicorn.Config("app.main:create_app", factory=True)
    uvicorn.Server(config).run(sockets=[sock])


if __name__ == "__main__":
    main()
