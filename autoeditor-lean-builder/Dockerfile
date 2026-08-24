FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive
ENV ANDROID_HOME=/opt/android-sdk
ENV PATH="${PATH}:${ANDROID_HOME}/cmdline-tools/latest/bin:${ANDROID_HOME}/platform-tools:/opt/scripts"

# 安装基础工具
RUN apt-get update && apt-get install -y \
    openjdk-17-jdk \
    wget unzip git \
    imagemagick \
    python3 python3-pip \
    jq \
    xmlstarlet \
    apksigner \
    zipalign \
    && rm -rf /var/lib/apt/lists/*

# 安装 Android SDK (仅需要 platform-tools 和 build-tools)
RUN mkdir -p ${ANDROID_HOME}/cmdline-tools && \
    wget -q https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip -O /tmp/cmdline-tools.zip && \
    unzip -q /tmp/cmdline-tools.zip -d ${ANDROID_HOME}/cmdline-tools && \
    mv ${ANDROID_HOME}/cmdline-tools/cmdline-tools ${ANDROID_HOME}/cmdline-tools/latest && \
    rm /tmp/cmdline-tools.zip && \
    yes | sdkmanager --licenses && \
    sdkmanager "platforms;android-34" "build-tools;34.0.0"

# 安装 apktool
RUN wget -q https://bitbucket.org/iBotPeaches/apktool/downloads/apktool_2.9.3.jar \
    -O /usr/local/bin/apktool.jar && \
    wget -q https://raw.githubusercontent.com/iBotPeaches/Apktool/master/scripts/linux/apktool \
    -O /usr/local/bin/apktool && chmod +x /usr/local/bin/apktool

# 安装 Python 依赖
RUN pip3 install lxml beautifulsoup4

# 复制构建脚本
COPY scripts/ /opt/scripts/
RUN chmod +x /opt/scripts/*.sh /opt/scripts/*.py

# 工作目录
WORKDIR /workspace
VOLUME ["/workspace", "/output", "/keys", "/uploads"]

ENTRYPOINT ["/opt/scripts/build.sh"]
