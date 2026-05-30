FROM node:18-slim

# تثبيت المتصفح والمكتبات المطلوبة
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-ipafont-gothic \
    fonts-wqy-zenhei \
    fonts-thai-tlwg \
    fonts-kacst \
    fonts-freefont-ttf \
    libxss1 \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# إعدادات البيئة للمتصفح
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# إنشاء مجلد العمل
WORKDIR /app

# نسخ ملفات المشروع
COPY package*.json ./
RUN npm install

# نسخ باقي الملفات
COPY . .

# فتح المنفذ
EXPOSE 3000

# تشغيل السيرفر
CMD ["node", "server.js"]
