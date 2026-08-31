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
 * Identifies a song from an audio or video media URL using ACRCloud Music Recognition API.
 */
export async function identifySong(audioOrVideoUrl: string): Promise<SongResult> {
  const rawHost = process.env.ACRCLOUD_HOST;
  const accessKey = process.env.ACRCLOUD_ACCESS_KEY;
  const accessSecret = process.env.ACRCLOUD_ACCESS_SECRET;

  if (!rawHost || !accessKey || !accessSecret) {
    logger.warn('ACRCloud credentials (ACRCLOUD_HOST, ACRCLOUD_ACCESS_KEY, ACRCLOUD_ACCESS_SECRET) are missing in environment variables');
    throw new MusicRecognitionApiError('ACRCloud credentials are missing in environment variables.');
  }

  const host = rawHost.replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
  const endpoint = `https://${host}/v1/identify`;

  logger.info('Audio/media retrieval started', { mediaUrl: audioOrVideoUrl });

  let sampleBuffer: Buffer;
  try {
    const response = await axios.get(audioOrVideoUrl, {
      responseType: 'arraybuffer',
      timeout: 15000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
    });

    const fullBuffer = Buffer.from(response.data);
    if (!fullBuffer || fullBuffer.length === 0) {
      throw new MusicRecognitionApiError('Downloaded audio/media file is empty.');
    }

    // Limit sample buffer size to 3MB for fast serverless execution
    sampleBuffer = fullBuffer.length > 3 * 1024 * 1024
      ? fullBuffer.subarray(0, 3 * 1024 * 1024)
      : fullBuffer;
  } catch (error: unknown) {
    if (error instanceof MusicRecognitionApiError) throw error;
    logger.error('Failed to download audio/media buffer from URL', error);
    throw new MusicRecognitionApiError('Failed to fetch audio/media content for music recognition.');
  }

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

    logger.info('ACRCloud request started', { endpoint });

    const response = await axios.post(endpoint, formData, {
      timeout: 20000,
    });

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

    logger.info('ACRCloud recognition result', {
      artist: songResult.artist,
      title: songResult.title,
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
