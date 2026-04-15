ARG BUILD_FROM
FROM ${BUILD_FROM}

ENV LANG C.UTF-8

# Runtime dependencies for the add-on service
RUN apk add --no-cache \
    bash \
    curl \
    nodejs \
    npm

WORKDIR /app

# Install backend dependencies
COPY backend/package.json /app/backend/package.json
RUN cd /app/backend && npm install --omit=dev

# Copy add-on files
COPY backend /app/backend
COPY run.sh /run.sh
RUN chmod a+x /run.sh

CMD [ "/run.sh" ]
