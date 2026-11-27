import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { setTokenKey } from '../staff/api';
import { Admin } from './Admin';
import '../styles.css';
import '../staff/portal.css';

setTokenKey('afyapay.admin');

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Admin />
  </StrictMode>,
);
