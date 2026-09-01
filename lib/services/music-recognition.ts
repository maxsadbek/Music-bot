import axios from 'axios';
import crypto from 'crypto';
import { logger } from '../utils/logger';
import {
  MusicNotFoundError,
  MusicRecognitionApiError,
} from '../utils/errors';

export interface SongResult {
  title: string;
  artist: string;
  album?: string;
  releaseDate?: string;
  spotifyUrl?: string;
  appleMusicUrl?: string;
}

/**
 * Generates HMAC-SHA1 signature required by ACRCloud Identify API.
 */
function generateAcrCloudSignature(
  method: string,
  uri: string,
  accessKey: string,
  accessSecret: string,
  dataType: string,
  signatureVersion: string,
  timestamp: string
): string {
  const stringToSign = [
    method.toUpperCase(),
    uri,
    accessKey,
    dataType,
    signatureVersion,
    timestamp,
  ].join('\n');

  return crypto
    .createHmac('sha1', accessSecret)
    .update(Buffer.from(stringToSign, 'utf-8'))
    .digest('base64');
}

/**
 * Downloads media from direct media URL as a Buffer and verifies it is valid media (not HTML).
 */
export async function downloadMediaBuffer(url: string): Promise<Buffer> {
  try {
    const response = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: 15000,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
    });

    const contentType = String(response.headers?.['content-type'] || '').toLowerCase();
    if (contentType.includes('text/html') || contentType.includes('application/xhtml')) {
      logger.error('Fetched URL returned HTML Content-Type instead of media', { contentType, mediaUrl: url });
      throw new MusicRecognitionApiError('Fetched media URL returned HTML instead of audio/video media.');
    }

    const fullBuffer = Buffer.from(response.data);
    if (!fullBuffer || fullBuffer.length === 0) {
      throw new MusicRecognitionApiError('Downloaded audio/media file is empty.');
    }

    const headText = fullBuffer.subarray(0, 200).toString('utf-8').trim().toLowerCase();
    if (
      headText.startsWith('<!doctype') ||
      headText.startsWith('<html') ||
      headText.startsWith('<head') ||
      headText.includes('<html') ||
      headText.includes('<!doctype html')
    ) {
      logger.error('Downloaded content contains HTML page structure', { mediaUrl: url, snippet: headText.slice(0, 100) });
      throw new MusicRecognitionApiError('Downloaded content is an HTML page, not audio/video media bytes.');
    }

    return fullBuffer;
  } catch (error: unknown) {
    if (error instanceof MusicNotFoundError || error instanceof MusicRecognitionApiError) {
      throw error;
    }
    logger.error('Failed to download audio/media buffer from URL', error);
    throw new MusicRecognitionApiError('Failed to fetch audio/media content for music recognition.');
  }
}

/**
 * Identifies a song from an audio/video media URL or pre-downloaded Buffer using ACRCloud Music Recognition API.
 */
export async function identifySong(audioOrVideoUrlOrBuffer: string | Buffer): Promise<SongResult> {
  const totalStart = Date.now();
  const rawHost = process.env.ACRCLOUD_HOST;
  const accessKey = process.env.ACRCLOUD_ACCESS_KEY;
  const accessSecret = process.env.ACRCLOUD_ACCESS_SECRET;

  if (!rawHost || !accessKey || !accessSecret) {
    logger.warn('ACRCloud credentials (ACRCLOUD_HOST, ACRCLOUD_ACCESS_KEY, ACRCLOUD_ACCESS_SECRET) are missing in environment variables');
    throw new MusicRecognitionApiError('ACRCloud credentials are missing in environment variables.');
  }

  const host = rawHost.replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
  const endpoint = `https://${host}/v1/identify`;

  let fullBuffer: Buffer;
  if (Buffer.isBuffer(audioOrVideoUrlOrBuffer)) {
    fullBuffer = audioOrVideoUrlOrBuffer;
  } else {
    logger.info('[PERF] Audio/media retrieval from URL started', { mediaUrl: audioOrVideoUrlOrBuffer });
    fullBuffer = await downloadMediaBuffer(audioOrVideoUrlOrBuffer);
  }

  if (!fullBuffer || fullBuffer.length === 0) {
    throw new MusicRecognitionApiError('Downloaded audio/media file is empty.');
  }

  const headText = fullBuffer.subarray(0, 200).toString('utf-8').trim().toLowerCase();
  if (
    headText.startsWith('<!doctype') ||
    headText.startsWith('<html') ||
    headText.startsWith('<head') ||
    headText.includes('<html') ||
    headText.includes('<!doctype html')
  ) {
    throw new MusicRecognitionApiError('Downloaded content is an HTML page, not audio/video media bytes.');
  }

  // Limit sample to 1MB — ACRCloud only needs a short audio fingerprint
  // Reducing from 3MB to 1MB cuts upload time ~3x with no accuracy loss
  const sampleBuffer = fullBuffer.length > 1 * 1024 * 1024
    ? fullBuffer.subarray(0, 1 * 1024 * 1024)
    : fullBuffer;

  try {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const dataType = 'audio';
    const signatureVersion = '1';
    const uri = '/v1/identify';

    const signature = generateAcrCloudSignature(
      'POST',
      uri,
      accessKey,
      accessSecret,
      dataType,
      signatureVersion,
      timestamp
    );

    const formData = new FormData();
    formData.append('sample', new Blob([new Uint8Array(sampleBuffer)]), 'sample.mp3');
    formData.append('sample_bytes', sampleBuffer.length.toString());
    formData.append('access_key', accessKey);
    formData.append('data_type', dataType);
    formData.append('signature_version', signatureVersion);
    formData.append('signature', signature);
    formData.append('timestamp', timestamp);

    const acrApiStart = Date.now();
    logger.info('[PERF] ACRCloud API request', { endpoint, sampleBytes: sampleBuffer.length });

    const response = await axios.post(endpoint, formData, {
      timeout: 15000,
    });
    logger.info('[PERF] ACRCloud API response', { duration: `${Date.now() - acrApiStart}ms` });

    const data = response.data;

    if (!data || !data.status) {
      throw new MusicRecognitionApiError('Received invalid response from ACRCloud API.');
    }

    const statusCode = data.status.code;
    logger.info('ACRCloud response status', {
      code: statusCode,
      msg: data.status.msg,
    });

    if (statusCode !== 0) {
      if (statusCode === 1001 || !data.metadata?.music || data.metadata.music.length === 0) {
        logger.info('No song match returned by ACRCloud API', { code: statusCode, msg: data.status.msg });
        throw new MusicNotFoundError();
      }
      logger.error('ACRCloud API response error', { code: statusCode, msg: data.status.msg });
      throw new MusicRecognitionApiError(`ACRCloud error (${statusCode}): ${data.status.msg}`);
    }

    const music = data.metadata?.music?.[0];
    if (!music) {
      logger.info('No song match metadata found in ACRCloud response');
      throw new MusicNotFoundError();
    }

    const title = music.title?.trim();
    const artist = Array.isArray(music.artists)
      ? music.artists.map((a: { name?: string }) => a.name?.trim()).filter(Boolean).join(', ')
      : undefined;

    if (!title || !artist) {
      throw new MusicNotFoundError();
    }

    const album = music.album?.name?.trim();
    const releaseDate = music.release_date?.trim();

    let spotifyUrl: string | undefined;
    if (music.external_metadata?.spotify?.track?.id) {
      spotifyUrl = `https://open.spotify.com/track/${music.external_metadata.spotify.track.id}`;
    }

    const songResult: SongResult = {
      title,
      artist,
      album: album || undefined,
      releaseDate: releaseDate || undefined,
      spotifyUrl: spotifyUrl || undefined,
    };

    logger.info('[PERF] ACRCloud recognition complete', {
      artist: songResult.artist,
      title: songResult.title,
      totalDuration: `${Date.now() - totalStart}ms`,
    });

    return songResult;
  } catch (error: unknown) {
    if (error instanceof MusicNotFoundError || error instanceof MusicRecognitionApiError) {
      throw error;
    }

    if (axios.isAxiosError(error)) {
      logger.error('ACRCloud API HTTP error', error.message);
      throw new MusicRecognitionApiError(`ACRCloud HTTP error: ${error.message}`);
    }

    logger.error('Unexpected error in ACRCloud music recognition', error);
    throw new MusicRecognitionApiError('Failed to execute music recognition.');
  }
}
