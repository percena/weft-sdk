import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import { EN_FALLBACK } from '@percena/weft-node'

i18n.use(initReactI18next).init({
  resources: {
    en: { translation: EN_FALLBACK },
  },
  lng: 'en',
  fallbackLng: 'en',
  interpolation: { escapeValue: false },
})

export default i18n