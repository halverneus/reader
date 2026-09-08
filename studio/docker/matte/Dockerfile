# Offline video matting for Metrik Studio: RobustVideoMatting (resnet50) on CUDA.
# Build: docker build -t metrik-matte docker/matte
FROM pytorch/pytorch:2.4.1-cuda12.1-cudnn9-runtime
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg git && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir av==12.3.0 tqdm pims
WORKDIR /app
RUN git clone --depth 1 https://github.com/PeterL1n/RobustVideoMatting.git rvm && \
    python -c "import torch, urllib.request; urllib.request.urlretrieve('https://github.com/PeterL1n/RobustVideoMatting/releases/download/v1.0.0/rvm_resnet50.pth','/app/rvm_resnet50.pth'); urllib.request.urlretrieve('https://github.com/PeterL1n/RobustVideoMatting/releases/download/v1.0.0/rvm_mobilenetv3.pth','/app/rvm_mobilenetv3.pth')"
COPY matte.py /app/matte.py
ENTRYPOINT ["python", "/app/matte.py"]
