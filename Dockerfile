# ══════════════════════════════════════════════════════════════════════════════
# Stage 1 – build reader
#
# Ubuntu 24.04 ships a complete toolchain and all needed dev libraries.
# The .cargo/config.toml linuxbrew workaround is only for local (immutable
# Fedora) builds — we drop it here and let cargo use Ubuntu's g++.
# ══════════════════════════════════════════════════════════════════════════════
FROM ubuntu:24.04 AS builder

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
        # Core build tools
        ca-certificates build-essential pkg-config curl \
        # Slint UI: Wayland + fonts
        libwayland-dev wayland-protocols \
        libfontconfig-dev libfreetype-dev libexpat1-dev \
        libxkbcommon-dev \
        # Slint: X11 fallback (optional but avoids link errors)
        libx11-dev libxcb1-dev \
        # rodio → cpal → ALSA
        libasound2-dev \
        # rfd file dialogs (GTK3 backend)
        libgtk-3-dev \
    && rm -rf /var/lib/apt/lists/*

# Install stable Rust toolchain
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | \
    sh -s -- -y --no-modify-path --default-toolchain stable
ENV PATH="/root/.cargo/bin:${PATH}"

WORKDIR /build
COPY . .

# Drop the linuxbrew workaround — Ubuntu has everything natively.
RUN rm .cargo/config.toml

RUN cargo build --release \
    && strip target/release/reader


# ══════════════════════════════════════════════════════════════════════════════
# Stage 2 – dist (single binary output layer)
#
# Usage:  docker build --output . .   →  ./reader
# ══════════════════════════════════════════════════════════════════════════════
FROM scratch AS dist
COPY --from=builder /build/target/release/reader /reader
