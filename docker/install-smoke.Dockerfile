FROM node:20-bookworm

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        bash \
        ca-certificates \
        curl \
        python3 \
        python3-venv \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY . /app

RUN chmod +x scripts/setup.sh scripts/test.sh scripts/install_smoke.sh scripts/install_smoke_container.sh

CMD ["/bin/bash", "scripts/install_smoke_container.sh"]
