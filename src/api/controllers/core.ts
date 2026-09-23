import { PassThrough } from "stream";
import path from "path";
import _ from "lodash";
import mime from "mime";
import axios, { AxiosRequestConfig, AxiosResponse } from "axios";

import APIException from "@/lib/exceptions/APIException.ts";
import EX from "@/api/consts/exceptions.ts";
import { createParser } from "eventsource-parser";
import logger from "@/lib/logger.ts";
import util from "@/lib/util.ts";

// 模型名称
const MODEL_NAME = "jimeng";
// Dreamina 国际站。抓包主机是 dreamina.capcut.com，aid 是 513641。
export const BASE_URL = "https://dreamina.capcut.com";
export const DEFAULT_ASSISTANT_ID = 513641;
// 请求头 Appvr，同时参与 Sign。
export const VERSION_CODE = "5.8.0";
// 生成接口的 web_version / da_version，三处控制器共用这一份。
export const WEB_VERSION = "7.5.0";
export const DRAFT_VERSION = "3.3.20";
// 平台代码
const PLATFORM_CODE = "7";
const ROTATING_COOKIE_KEYS = new Map<string, string>([
  ["mstoken", "msToken"],
  ["odin_tt", "odin_tt"],
  ["store-country-sign", "store-country-sign"],
]);
// 设备ID
const DEVICE_ID = Math.random() * 999999999999999999 + 7000000000000000000;
// WebID
const WEB_ID = Math.random() * 999999999999999999 + 7000000000000000000;
// 用户ID
const USER_ID = util.uuid(false);
// 最大重试次数
const MAX_RETRY_COUNT = 3;
// 重试延迟
const RETRY_DELAY = 5000;
// 伪装headers
const FAKE_HEADERS = {
  Accept: "application/json, text/plain, */*",
  "Accept-Encoding": "gzip, deflate, br, zstd",
  "Accept-language": "zh-CN,zh;q=0.9",
  "Cache-control": "no-cache",
  Appid: `${DEFAULT_ASSISTANT_ID}`,
  Appvr: VERSION_CODE,
  Origin: BASE_URL,
  Pragma: "no-cache",
  Priority: "u=1, i",
  Referer: `${BASE_URL}/ai-tool/generate`,
  Pf: PLATFORM_CODE,
  "Sec-Ch-Ua":
    '"Google Chrome";v="142", "Chromium";v="142", "Not_A Brand";v="24"',
  "Sec-Ch-Ua-Mobile": "?0",
  "Sec-Ch-Ua-Platform": '"Windows"',
  "Sec-Fetch-Dest": "empty",
  "Sec-Fetch-Mode": "cors",
  "Sec-Fetch-Site": "same-origin",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
};
// 文件最大大小
const FILE_MAX_SIZE = 100 * 1024 * 1024;

/**
 * 获取缓存中的access_token
 *
 * 目前jimeng的access_token是固定的，暂无刷新功能
 *
 * @param refreshToken 用于刷新access_token的refresh_token
 */
export async function acquireToken(refreshToken: string): Promise<string> {
  return refreshToken;
}

/**
 * 生成cookie
 */
export function generateCookie(refreshToken: string) {
  return [
    `_tea_web_id=${WEB_ID}`,
    `is_staff_user=false`,
    `store-region=cn-gd`,
    `store-region-src=uid`,
    `sid_guard=${refreshToken}%7C${util.unixTimestamp()}%7C5184000%7CMon%2C+03-Feb-2025+08%3A17%3A09+GMT`,
    `uid_tt=${USER_ID}`,
    `uid_tt_ss=${USER_ID}`,
    `sid_tt=${refreshToken}`,
    `sessionid=${refreshToken}`,
    `sessionid_ss=${refreshToken}`,
    `sid_tt=${refreshToken}`
  ].join("; ");
}

type RotatingCookieHandler = (sessionId: string, updates: Record<string, string>) => void;
let rotatingCookieHandler: RotatingCookieHandler | undefined;

/** 账号池注册。响应 Set-Cookie 带回 msToken、odin_tt、store-country-sign 时写回原会话。 */
export function setRotatingCookieHandler(handler?: RotatingCookieHandler) {
  rotatingCookieHandler = handler;
}

function isStoredCookie(value: string): boolean {
  return /(?:^|[;\s])(?:sessionid|sessionid_ss|sid_tt)\s*=/i.test(value);
}

function normalizeCookie(value: string): string {
  return value
    .replace(/^\s*cookie\s*:\s*/i, "")
    .replace(/[\r\n]+/g, ";")
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .join("; ");
}

function cookieValue(cookie: string, name: string): string | undefined {
  const target = name.toLowerCase();
  for (const part of cookie.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim().toLowerCase() !== target) continue;
    const value = part.slice(separator + 1).trim();
    return value || undefined;
  }
  return undefined;
}

function resolveCookie(credential: string): string {
  const trimmed = credential.trim();
  if (!isStoredCookie(trimmed)) return generateCookie(trimmed);
  return normalizeCookie(trimmed);
}

function readSetCookies(headers: Record<string, any> | undefined): string[] {
  const value = headers?.["set-cookie"] ?? headers?.["Set-Cookie"];
  if (!value) return [];
  return Array.isArray(value) ? value : [String(value)];
}

function rememberRotatingCookies(sentCookie: string, responseHeaders: Record<string, any> | undefined) {
  if (!rotatingCookieHandler) return;
  const updates: Record<string, string> = {};
  for (const item of readSetCookies(responseHeaders)) {
    const pair = String(item).split(";")[0] || "";
    const separator = pair.indexOf("=");
    if (separator < 0) continue;
    const canonical = ROTATING_COOKIE_KEYS.get(pair.slice(0, separator).trim().toLowerCase());
    if (!canonical) continue;
    const value = pair.slice(separator + 1).trim();
    if (value) updates[canonical] = value;
  }
  if (!Object.keys(updates).length) return;
  let sessionId = cookieValue(sentCookie, "sessionid")
    || cookieValue(sentCookie, "sessionid_ss")
    || cookieValue(sentCookie, "sid_tt");
  if (!sessionId) return;
  try { sessionId = decodeURIComponent(sessionId); } catch { /* 保持原值 */ }
  try {
    rotatingCookieHandler(sessionId, updates);
  } catch (error: any) {
    logger.warn(`回写会话 Cookie 失败: ${error?.message || error}`);
  }
}

/**
 * 获取积分信息
 *
 * @param refreshToken 用于刷新access_token的refresh_token
 */
export async function getCredit(refreshToken: string) {
  const {
    credit: { gift_credit, purchase_credit, vip_credit }
  } = await request("POST", "/commerce/v1/benefits/user_credit", refreshToken, {
    data: {},
    headers: {
      // Cookie: '<complete-cookie-header-from-the-account-pool>',
      Referer: `${BASE_URL}/ai-tool/generate`,
      // "Device-Time": 1733966964,
      // Sign: "f3dbb824b378abea7c03cbb152b3a365"
    }
  });
  logger.info(`\n积分信息: \n赠送积分: ${gift_credit}, 购买积分: ${purchase_credit}, VIP积分: ${vip_credit}`);
  return {
    giftCredit: gift_credit,
    purchaseCredit: purchase_credit,
    vipCredit: vip_credit,
    totalCredit: gift_credit + purchase_credit + vip_credit
  }
}

/**
 * 接收今日积分
 *
 * @param refreshToken 用于刷新access_token的refresh_token
 */
export async function receiveCredit(refreshToken: string) {
  logger.info("正在收取今日积分...")
  const { cur_total_credits, receive_quota } = await request("POST", "/commerce/v1/benefits/credit_receive", refreshToken, {
    data: {
      time_zone: "Asia/Shanghai"
    },
    headers: {
      Referer: `${BASE_URL}/ai-tool/generate`
    }
  });
  logger.info(`\n今日${receive_quota}积分收取成功\n剩余积分: ${cur_total_credits}`);
  return cur_total_credits;
}

/**
 * 请求jimeng
 *
 * @param method 请求方法
 * @param uri 请求路径
 * @param params 请求参数
 * @param headers 请求头
 */
export async function request(
  method: string,
  uri: string,
  refreshToken: string,
  options: AxiosRequestConfig = {}
) {
  const token = await acquireToken(refreshToken);
  const sentCookie = resolveCookie(token);
  const deviceTime = util.unixTimestamp();
  const sign = util.md5(
    `9e2c|${uri.slice(-7)}|${PLATFORM_CODE}|${VERSION_CODE}|${deviceTime}||11ac`
  );

  const fullUrl = `${BASE_URL}${uri}`;
  const country = (cookieValue(sentCookie, "store-country-code") || "").toLowerCase();
  const requestParams = {
    aid: DEFAULT_ASSISTANT_ID,
    device_platform: "web",
    region: country ? country.toUpperCase() : "US",
    webId: cookieValue(sentCookie, "_tea_web_id") || WEB_ID,
    ...(options.params || {}),
  };

  const headers = {
    ...FAKE_HEADERS,
    Cookie: sentCookie,
    "Device-Time": deviceTime,
    Sign: sign,
    "Sign-Ver": "1",
    ...(country ? { "store-country-code": country } : {}),
    ...(cookieValue(sentCookie, "store-country-code-src")
      ? { "store-country-code-src": cookieValue(sentCookie, "store-country-code-src") }
      : {}),
    ...(options.headers || {}),
  };

  logger.info(`发送请求: ${method.toUpperCase()} ${fullUrl}`);
  logger.info(`请求参数: ${JSON.stringify(requestParams)}`);
  logger.info(`请求数据: ${JSON.stringify(options.data || {})}`);

  // 添加重试逻辑
  let retries = 0;
  const maxRetries = 3; // 最大重试次数
  let lastError = null;

  while (retries <= maxRetries) {
    try {
      if (retries > 0) {
        logger.info(`第 ${retries} 次重试请求: ${method.toUpperCase()} ${fullUrl}`);
        // 重试前等待一段时间
        await new Promise(resolve => setTimeout(resolve, 1000 * retries));
      }

      const response = await axios.request({
        method,
        url: fullUrl,
        params: requestParams,
        headers: headers,
        timeout: 45000, // 增加超时时间到45秒
        validateStatus: () => true, // 允许任何状态码
        ..._.omit(options, "params", "headers"),
      });

      // 记录响应状态和头信息
      logger.info(`响应状态: ${response.status} ${response.statusText}`);
      rememberRotatingCookies(String(headers.Cookie || headers.cookie || sentCookie), response.headers);

      // 流式响应直接返回response
      if (options.responseType == "stream") return response;

      // 记录响应数据摘要
      const responseDataSummary = JSON.stringify(response.data).substring(0, 500) +
        (JSON.stringify(response.data).length > 500 ? "..." : "");
      logger.info(`响应数据摘要: ${responseDataSummary}`);

      // 检查HTTP状态码
      if (response.status >= 400) {
        logger.warn(`HTTP错误: ${response.status} ${response.statusText}`);
        if (retries < maxRetries) {
          retries++;
          continue;
        }
      }

      return checkResult(response);
    }
    catch (error) {
      lastError = error;
      logger.error(`请求失败 (尝试 ${retries + 1}/${maxRetries + 1}): ${error.message}`);

      // 如果是网络错误或超时，尝试重试
      if ((error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT' ||
        error.message.includes('timeout') || error.message.includes('network')) &&
        retries < maxRetries) {
        retries++;
        continue;
      }

      // 其他错误直接抛出
      break;
    }
  }

  // 所有重试都失败了，抛出最后一个错误
  logger.error(`请求失败，已重试 ${retries} 次: ${lastError.message}`);
  if (lastError.response) {
    logger.error(`响应状态: ${lastError.response.status}`);
    logger.error(`响应数据: ${JSON.stringify(lastError.response.data)}`);
  }
  throw lastError;
}

/**
 * 预检查文件URL有效性
 *
 * @param fileUrl 文件URL
 */
export async function checkFileUrl(fileUrl: string) {
  if (util.isBASE64Data(fileUrl)) return;
  const result = await axios.head(fileUrl, {
    timeout: 15000,
    validateStatus: () => true,
  });
  if (result.status >= 400)
    throw new APIException(
      EX.API_FILE_URL_INVALID,
      `File ${fileUrl} is not valid: [${result.status}] ${result.statusText}`
    );
  // 检查文件大小
  if (result.headers && result.headers["content-length"]) {
    const fileSize = parseInt(result.headers["content-length"], 10);
    if (fileSize > FILE_MAX_SIZE)
      throw new APIException(
        EX.API_FILE_EXECEEDS_SIZE,
        `File ${fileUrl} is not valid`
      );
  }
}

/**
 * 上传文件
 *
 * @param refreshToken 用于刷新access_token的refresh_token
 * @param fileUrl 文件URL或BASE64数据或本地路径
 * @param isVideoImage 是否是用于视频图像
 * @returns 上传结果，包含image_uri
 */
export async function uploadFile(
  refreshToken: string,
  fileUrl: string,
  isVideoImage: boolean = false
): Promise<{ image_uri: string; uri: string }> {
  // 只显示类型信息，不显示完整的base64内容
  const fileDesc = fileUrl.startsWith('data:')
    ? `base64图片(${fileUrl.length}字符)`
    : fileUrl.substring(0, 100);
  logger.info(`开始上传文件: ${fileDesc}`);

  // 获取文件内容
  let fileData: Buffer;
  let filename: string;

  if (util.isBASE64Data(fileUrl)) {
    // BASE64 数据
    const mimeType = util.extractBASE64DataFormat(fileUrl);
    const ext = mime.getExtension(mimeType || 'image/png');
    filename = `${util.uuid()}.${ext}`;
    fileData = Buffer.from(util.removeBASE64DataHeader(fileUrl), "base64");
  } else if (fileUrl.startsWith('http://') || fileUrl.startsWith('https://')) {
    // 网络URL
    await checkFileUrl(fileUrl);
    filename = path.basename(fileUrl).split('?')[0] || `${util.uuid()}.jpg`;
    const response = await axios.get(fileUrl, {
      responseType: "arraybuffer",
      maxContentLength: FILE_MAX_SIZE,
      timeout: 60000,
    });
    fileData = Buffer.from(response.data);
  } else {
    // 本地文件路径
    const fs = await import('fs');
    const absolutePath = path.resolve(fileUrl);
    if (!fs.existsSync(absolutePath)) {
      throw new APIException(EX.API_FILE_URL_INVALID, `文件不存在: ${absolutePath}`);
    }
    filename = path.basename(fileUrl);
    fileData = fs.readFileSync(absolutePath);
  }

  logger.info(`文件大小: ${fileData.length} bytes, 文件名: ${filename}`);

  // 获取上传令牌
  // 旧版网页端的视频参考图使用 video_cover 场景；新版接口有时只接受数字场景 2。
  // 先尝试视频场景，失败后回退到当前通用场景，兼容两代接口。
  const uploadScenes: Array<string | number> = isVideoImage
    ? ["video_cover", 2]
    : [2];
  let uploadAuth: any = null;
  let lastUploadAuthError: any = null;
  for (const scene of uploadScenes) {
    try {
      uploadAuth = await request(
        'POST',
        `/mweb/v1/get_upload_token?aid=${DEFAULT_ASSISTANT_ID}&da_version=${DRAFT_VERSION}&aigc_features=app_lip_sync`,
        refreshToken,
        { data: { scene } }
      );
      if (uploadAuth?.access_key_id) break;
    } catch (error) {
      lastUploadAuthError = error;
      logger.warn(`获取${isVideoImage ? "视频参考图" : "图片"}上传令牌失败，尝试兼容场景`);
    }
  }

  if (!uploadAuth || !uploadAuth.access_key_id) {
    throw new APIException(EX.API_REQUEST_FAILED, '获取上传凭证失败，账号可能已掉线');
  }

  logger.info('获取上传令牌成功');

  // 计算文件CRC32 - 注意：需要转换为无符号整数再转十六进制
  // crc-32 包返回有符号整数，需要 >>> 0 转换为无符号
  const crc32Value = util.crc32(fileData);
  const imageCrc32 = (crc32Value >>> 0).toString(16);
  logger.info(`文件CRC32: ${imageCrc32}`);

  // 准备获取上传凭证的请求参数
  const getUploadImageProofRequestParams = {
    Action: 'ApplyImageUpload',
    FileSize: fileData.length,
    ServiceId: 'tb4s082cfz',
    Version: '2018-08-01',
    s: util.generateRandomString({ length: 11, charset: 'alphanumeric' }),
  };

  // 生成AWS签名请求头
  const requestHeadersInfo = await generateAWSAuthorizationHeader(
    uploadAuth.access_key_id,
    uploadAuth.secret_access_key,
    uploadAuth.session_token,
    'cn-north-1',
    'imagex',
    'GET',
    getUploadImageProofRequestParams,
  );

  // 获取图片上传凭证
  const uploadImgRes = await axios.get(
    'https://imagex.bytedanceapi.com/?' + new URLSearchParams(getUploadImageProofRequestParams as any).toString(),
    { headers: requestHeadersInfo, timeout: 30000 }
  );

  if (uploadImgRes.data?.['Response ']?.hasOwnProperty('Error')) {
    throw new APIException(EX.API_REQUEST_FAILED, uploadImgRes.data['Response ']['Error']['Message']);
  }

  const UploadAddress = uploadImgRes.data.Result.UploadAddress;
  const uploadImgUrl = `https://${UploadAddress.UploadHosts[0]}/upload/v1/${UploadAddress.StoreInfos[0].StoreUri}`;

  logger.info(`上传图片到: ${uploadImgUrl}`);

  // 上传图片
  const imageUploadRes = await axios.post(
    uploadImgUrl,
    fileData,
    {
      headers: {
        Authorization: UploadAddress.StoreInfos[0].Auth,
        'Content-Crc32': imageCrc32,
        'Content-Type': 'application/octet-stream',
      },
      timeout: 60000,
    }
  );

  if (imageUploadRes.data.code !== 2000) {
    throw new APIException(EX.API_REQUEST_FAILED, imageUploadRes.data.message || '上传文件失败');
  }

  logger.info('图片上传成功，提交上传');

  // 提交上传
  const commitImgParams = {
    Action: 'CommitImageUpload',
    FileSize: fileData.length,
    ServiceId: 'tb4s082cfz',
    Version: '2018-08-01',
  };

  const commitImgContent = {
    SessionKey: UploadAddress.SessionKey,
  };

  const commitImgHead = await generateAWSAuthorizationHeader(
    uploadAuth.access_key_id,
    uploadAuth.secret_access_key,
    uploadAuth.session_token,
    'cn-north-1',
    'imagex',
    'POST',
    commitImgParams,
    commitImgContent,
  );

  const commitImg = await axios.post(
    'https://imagex.bytedanceapi.com/?' + new URLSearchParams(commitImgParams as any).toString(),
    commitImgContent,
    {
      headers: {
        ...commitImgHead,
        'Content-Type': 'application/json',
      },
      timeout: 30000,
    }
  );

  if (commitImg.data?.['Response ']?.hasOwnProperty('Error')) {
    throw new APIException(EX.API_REQUEST_FAILED, commitImg.data['Response ']['Error']['Message']);
  }

  const imageUri = commitImg.data.Result.Results[0].Uri;
  logger.info(`文件上传成功，URI: ${imageUri}`);

  return {
    image_uri: imageUri,
    uri: imageUri,
  };
}

/**
 * 生成AWS授权请求头
 */
async function generateAWSAuthorizationHeader(
  accessKeyID: string,
  secretAccessKey: string,
  sessionToken: string,
  region: string,
  service: string,
  requestMethod: string,
  requestParams: any,
  requestBody: any = {},
): Promise<Record<string, string>> {
  const crypto = await import('crypto');

  // 获取当前ISO时间
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:\-]|\.\d{3}/g, '').slice(0, 15) + 'Z';
  const amzDay = amzDate.substring(0, 8);

  // 构建请求头
  const requestHeaders: Record<string, string> = {
    'X-Amz-Date': amzDate,
    'X-Amz-Security-Token': sessionToken,
  };

  if (Object.keys(requestBody).length > 0) {
    requestHeaders['X-Amz-Content-Sha256'] = crypto
      .createHash('sha256')
      .update(JSON.stringify(requestBody))
      .digest('hex');
  }

  // 生成签名
  const credentialString = `${amzDay}/${region}/${service}/aws4_request`;

  const signedHeaders = Object.keys(requestHeaders)
    .map(k => k.toLowerCase())
    .sort()
    .join(';');

  const canonicalHeaders = Object.keys(requestHeaders)
    .sort()
    .map(k => `${k.toLowerCase()}:${requestHeaders[k]}`)
    .join('\n') + '\n';

  const bodyHash = Object.keys(requestBody).length > 0
    ? crypto.createHash('sha256').update(JSON.stringify(requestBody)).digest('hex')
    : crypto.createHash('sha256').update('').digest('hex');

  const canonicalRequest = [
    requestMethod.toUpperCase(),
    '/',
    new URLSearchParams(requestParams).toString(),
    canonicalHeaders,
    signedHeaders,
    bodyHash,
  ].join('\n');

  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialString,
    crypto.createHash('sha256').update(canonicalRequest).digest('hex'),
  ].join('\n');

  // 生成签名密钥
  const kDate = crypto.createHmac('sha256', 'AWS4' + secretAccessKey).update(amzDay).digest();
  const kRegion = crypto.createHmac('sha256', kDate).update(region).digest();
  const kService = crypto.createHmac('sha256', kRegion).update(service).digest();
  const signingKey = crypto.createHmac('sha256', kService).update('aws4_request').digest();

  const signature = crypto.createHmac('sha256', signingKey).update(stringToSign).digest('hex');

  const authorization = `AWS4-HMAC-SHA256 Credential=${accessKeyID}/${credentialString}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return {
    ...requestHeaders,
    'Authorization': authorization,
  };
}

/**
 * 检查请求结果
 *
 * @param result 结果
 */
export function checkResult(result: AxiosResponse) {
  const { ret, errmsg, data } = result.data;
  if (!_.isFinite(Number(ret))) return result.data;
  if (ret === '0') return data;
  
  // 记录详细的API错误信息
  logger.error(`❌ [API错误] 错误码: ${ret}, 错误消息: ${errmsg}`);
  
  // 即梦积分不足错误码：5000 (旧) 或 1006 (新)
  if (ret === '5000' || ret === '1006')
    throw new APIException(EX.API_IMAGE_GENERATION_INSUFFICIENT_POINTS, `[积分不足]: ${errmsg} (错误码: ${ret})`);
  throw new APIException(EX.API_REQUEST_FAILED, `[请求失败]: ${errmsg} (错误码: ${ret})`);
}

/**
 * Token切分
 *
 * @param authorization 认证字符串
 */
export function tokenSplit(authorization: string) {
  return authorization
    .replace(/^Bearer\s+/i, "")
    .split(",")
    .map((token) => token.trim())
    .filter(Boolean);
}

/**
 * 获取Token存活状态
 */
export async function getTokenLiveStatus(refreshToken: string) {
  const result = await request(
    "POST",
    "/passport/account/info/v2",
    refreshToken,
    {
      params: {
        account_sdk_source: "web",
      },
    }
  );
  try {
    const { user_id } = checkResult(result);
    return !!user_id;
  } catch (err) {
    return false;
  }
}
