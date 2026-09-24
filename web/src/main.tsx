import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
// 复用 Phase 2 设计系统令牌（light first，协同色 -ink 规则已固化）
import '../../design-system/tokens.css'
import './styles.css'

ReactDOM.createRoot(document.getElementById('root')!).render(<App />)
