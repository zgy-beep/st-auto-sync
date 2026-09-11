FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev --registry=https://registry.npmmirror.com

COPY src/ ./src/

ENV PORT=8765
ENV DATA_DIR=/app/data

VOLUME ["/app/data"]

EXPOSE 8765

CMD ["node", "src/index.js"]
