FROM node:20-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY src ./src
COPY ui ./ui

ENV PORT=8787
ENV DATA_DIR=/data

EXPOSE 8787

CMD ["npm", "start"]
