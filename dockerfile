FROM node:18

# Install python3 and yt-dlp dependencies
RUN apt-get update && apt-get install -y python3 python3-pip ffmpeg

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

EXPOSE 3000

CMD ["node", "server.js"]
