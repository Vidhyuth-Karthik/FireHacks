FROM python:3.12-slim

# Hugging Face Spaces run the container as user ID 1000 - create that
# user and switch to it before copying files in, so nothing ends up
# owned by root.
RUN useradd -m -u 1000 user
USER user
ENV HOME=/home/user \
    PATH=/home/user/.local/bin:$PATH

WORKDIR $HOME/app

COPY --chown=user requirements.txt .
RUN pip install --no-cache-dir --upgrade pip && \
    pip install --no-cache-dir -r requirements.txt

COPY --chown=user . .

# Spaces expect the container to listen on 7860 by default (see app_port
# in README.md).
EXPOSE 7860

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "7860"]
