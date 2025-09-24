FROM python:3.10-slim

# Allow statements and log messages to serve immediately
ENV PYTHONUNBUFFERED True

COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt

# Set the working directory
WORKDIR /app

COPY . /app

# Run the web service on container startup.
# --target は main.py 内の @functions_framework.http で修飾された関数名を指定
CMD ["functions-framework", "--target", "handle_request", "--signature-type", "http", "--port", "8080"]