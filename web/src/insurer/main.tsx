import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { setTokenKey } from '../staff/api';
import { Portal } from './Portal';
import '../styles.css';
import '../staff/portal.css';

setTokenKey('afyapay.insurer');

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Portal />
  </StrictMode>,
);
