export const CLIENT_ENV = {
  SERVER_URL:
    import.meta.env.VITE_SERVER_URL ||
    (typeof window !== 'undefined' && window.location?.origin ? window.location.origin : 'http://localhost:4000'),
};
