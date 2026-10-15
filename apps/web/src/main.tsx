import './credential.js';
import './i18n.js';
import './style.css';
import {createRoot} from 'react-dom/client';
import {BrowserRouter,Routes,Route,Link,useLocation} from 'react-router';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {useTranslation} from 'react-i18next';
import {useEffect} from 'react';
import {SessionProvider,useSession} from './session.js';
import {PreferencesProvider} from './preferences.js';
import {AuthPage} from './auth.js';
import {Workspace} from './workspace.js';
import {discardCredential} from './credential.js';
const client=new QueryClient({defaultOptions:{queries:{retry:false,staleTime:30_000},mutations:{retry:false}}});
function Pages(){const location=useLocation(),session=useSession();useEffect(()=>{if(!['/bootstrap','/verify-email','/reset-password','/accept-invite','/change-email'].includes(location.pathname))discardCredential();},[location.pathname]);return <Routes key={session.generation}><Route path="/login" element={<AuthPage key="login" mode="login"/>}/><Route path="/register" element={<AuthPage key="register" mode="register"/>}/><Route path="/bootstrap" element={<AuthPage key="bootstrap" mode="bootstrap"/>}/><Route path="/verify-email" element={<AuthPage key="verify" mode="verify"/>}/><Route path="/forgot-password" element={<AuthPage key="forgot" mode="forgot"/>}/><Route path="/reset-password" element={<AuthPage key="reset" mode="reset"/>}/><Route path="/" element={<Workspace/>}/><Route path="/accept-invite" element={<AuthPage key="invite" mode="invite"/>}/><Route path="/change-email" element={<AuthPage key="emailChange" mode="emailChange"/>}/><Route path="/profile" element={<Workspace/>}/><Route path="/security" element={<Workspace/>}/><Route path="/sessions" element={<Workspace/>}/><Route path="/invites" element={<Workspace/>}/><Route path="/roles" element={<Workspace/>}/><Route path="/roles/:id" element={<Workspace/>}/><Route path="/permissions" element={<Workspace/>}/><Route path="*" element={<Missing/>}/></Routes>;}
function Missing(){const {t}=useTranslation(),location=useLocation();const unavailable=location.pathname==='/unavailable',forbidden=location.pathname==='/403';return <main className="page-state"><h1>{t(unavailable?'unavailable':forbidden?'forbidden':'notFound')}</h1><p>{t(unavailable?'unavailableIntro':forbidden?'forbidden':'notFoundIntro')}</p><Link to="/login">{t('backLogin')}</Link></main>;}
createRoot(document.getElementById('root')!).render(<QueryClientProvider client={client}><BrowserRouter><PreferencesProvider><SessionProvider><Pages/></SessionProvider></PreferencesProvider></BrowserRouter></QueryClientProvider>);
