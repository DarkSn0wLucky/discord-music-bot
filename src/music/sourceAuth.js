const play = require("play-dl");
const { SOUNDCLOUD_CLIENT_ID, YOUTUBE_COOKIE } = require("../config");

async function initSourceAuth() {
  const tokenPayload = {};
  let soundCloudReady = false;

  if (YOUTUBE_COOKIE) {
    tokenPayload.youtube = { cookie: YOUTUBE_COOKIE };
  }

  if (SOUNDCLOUD_CLIENT_ID) {
    tokenPayload.soundcloud = { client_id: SOUNDCLOUD_CLIENT_ID };
    soundCloudReady = true;
  } else {
    try {
      const freeClientId = await play.getFreeClientID();
      tokenPayload.soundcloud = { client_id: freeClientId };
      soundCloudReady = true;
    } catch (error) {
      console.warn("[Music] SoundCloud client id not available:", error.message);
    }
  }

  if (Object.keys(tokenPayload).length > 0) {
    await play.setToken(tokenPayload);
  }

  return {
    soundCloudReady,
    youtubeCookieReady: Boolean(YOUTUBE_COOKIE),
  };
}

module.exports = {
  initSourceAuth,
};

