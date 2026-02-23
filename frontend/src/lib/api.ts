import axios from 'axios';

const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000/api';

const api = axios.create({
  baseURL: API_BASE_URL,
  headers: {
    'Content-Type': 'application/json',
  },
  timeout: 10000, // 10 second timeout
});

// Add auth token to requests
api.interceptors.request.use((config) => {
  const token = localStorage.getItem('clerk_token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

export const pdfApi = {
  upload: async (file: File) => {
    const formData = new FormData();
    formData.append('file', file);  // Changed from 'pdf' to 'file' for FastAPI
    const response = await api.post('/pdf/upload', formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
      timeout: 60000, // 60 second timeout for uploads
    });
    return response.data;
  },
};

export const youtubeApi = {
  search: async (query: string, maxResults = 10) => {
    const response = await api.get('/youtube/search', {
      params: { q: query, maxResults },
    });
    return response.data;
  },
  getVideo: async (videoId: string) => {
    const response = await api.get(`/youtube/video/${videoId}`);
    return response.data;
  },
};

export const audioApi = {
  uploadSample: async (file: File) => {
    const formData = new FormData();
    formData.append('file', file);  // Changed from 'audio' to 'file' for FastAPI
    const response = await api.post('/audio/upload-sample', formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
      timeout: 60000, // 60 second timeout for uploads
    });
    return response.data;
  },
};

export const queueApi = {
  create: async (data: {
    pdfUrl: string;
    videoId?: string;
    startTime?: number;
    endTime?: number;
    audioSampleUrl?: string;
  }) => {
    // Map to snake_case for Python backend
    const response = await api.post('/queue/create', {
      pdf_url: data.pdfUrl,
      video_id: data.videoId,
      start_time: data.startTime,
      end_time: data.endTime,
      audio_sample_url: data.audioSampleUrl,
    });
    return response.data;
  },
  getJob: async (jobId: string) => {
    const response = await api.get(`/queue/job/${jobId}`);
    return response.data;
  },
  getJobs: async () => {
    const response = await api.get('/queue/jobs');
    return response.data;
  },
};

export const paymentApi = {
  createOneTimeCheckout: async (data: { userId: string; userEmail: string; successUrl: string }) => {
    const response = await api.post('/payment/checkout/one-time', {
      price_id: '', // Will use backend default
      user_id: data.userId,
      user_email: data.userEmail,
      success_url: data.successUrl,
    });
    return response.data;
  },
  createSubscriptionCheckout: async (data: { userId: string; userEmail: string; successUrl: string }) => {
    const response = await api.post('/payment/checkout/subscription', {
      price_id: '', // Will use backend default
      user_id: data.userId,
      user_email: data.userEmail,
      success_url: data.successUrl,
    });
    return response.data;
  },
  getSubscriptionStatus: async () => {
    const response = await api.get('/payment/subscription-status');
    return response.data;
  },
};

export const resourcesApi = {
  getResources: async () => {
    const response = await api.get('/resources');
    return response.data;
  },
};

export default api;

