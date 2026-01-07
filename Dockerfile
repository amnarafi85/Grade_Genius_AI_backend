FROM node:20-bullseye

RUN apt-get update && apt-get install -y \
  poppler-utils \
  tesseract-ocr \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

ENV NODE_ENV=production
RUN npm run build

EXPOSE 10000

CMD ["node", "dist/server.js"]
