import {createContext,useContext,useEffect,useId,useState,type ReactNode} from 'react';
import {useTranslation} from 'react-i18next';
import type {Me,PublicSettings} from '@honocraft/contracts/http';
import type {Locale} from '@honocraft/contracts/common';
type Theme='light'|'dark'|'system';
type Preferences={locale:Locale;theme:Theme;setLocale:(value:Locale)=>void;setTheme:(value:Theme)=>void;defaults:(settings:PublicSettings,user?:Me['user'])=>void};
const Context=createContext<Preferences|null>(null);
export function PreferencesProvider({children}:{children:ReactNode}){
  const {i18n}=useTranslation();const [locale,setLocaleState]=useState<Locale>('en'),[theme,setThemeState]=useState<Theme>('system');
  const [manualLocale,setManualLocale]=useState(false),[manualTheme,setManualTheme]=useState(false);
  function setLocale(value:Locale){setManualLocale(true);setLocaleState(value);}
  function setTheme(value:Theme){setManualTheme(true);setThemeState(value);}
  function defaults(settings:PublicSettings,user?:Me['user']){if(!manualLocale)setLocaleState(user?.locale??settings.default_locale);if(!manualTheme)setThemeState(user?.theme??settings.default_theme);}
  useEffect(()=>{void i18n.changeLanguage(locale);document.documentElement.lang=locale;},[i18n,locale]);
  useEffect(()=>{const media=window.matchMedia('(prefers-color-scheme: dark)');const apply=()=>{document.documentElement.dataset.theme=theme==='system'?(media.matches?'dark':'light'):theme;};apply();media.addEventListener('change',apply);return()=>media.removeEventListener('change',apply);},[theme]);
  return <Context.Provider value={{locale,theme,setLocale,setTheme,defaults}}>{children}</Context.Provider>;
}
export function usePreferences(){const value=useContext(Context);if(!value)throw new Error('PREFERENCES_CONTEXT_MISSING');return value;}
export function PreferenceControls(){
  const {t}=useTranslation(),p=usePreferences(),id=useId();
  return <div className="preferences"><div><label htmlFor={id+'-language'}>{t('language')}</label><select id={id+'-language'} value={p.locale} onChange={event=>p.setLocale(event.target.value as Locale)}><option value="en">English</option><option value="zh-CN">简体中文</option></select></div><div><label htmlFor={id+'-theme'}>{t('appearance')}</label><select id={id+'-theme'} value={p.theme} onChange={event=>p.setTheme(event.target.value as Theme)}><option value="system">{t('system')}</option><option value="light">{t('light')}</option><option value="dark">{t('dark')}</option></select></div></div>;
}
