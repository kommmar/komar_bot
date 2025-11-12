// modules/indicators.js (ФИНАЛЬНАЯ ВЕРСИЯ - с исправленным RSI)

export const sum = (arr)=>arr.reduce((a,b)=>a+b,0);
export const MIN_DENOM = 1e-12; 

export const klineHistory = new Map(); 

export const lastClosedIndex = (kl)=> kl.length-1; 
export const closes = (kl)=> kl.map(c=>Number(c[4]));
export const volumes = (kl)=> kl.map(c=>Number(c[5]));

export const sma = (arr, p)=> {
    if (arr.length < p) return null;
    return sum(arr.slice(-p))/p;
}

export function ema(arr,p){
  if(arr.length<p) return null;
  const k=2/(p+1); 
  let prev=sum(arr.slice(0,p))/p; 
  for(let i=p;i<arr.length;i++){ prev = arr[i]*k + prev*(1-k); }
  return prev;
}

// +++ ФУНКЦИЯ RSI ПЕРЕПИСАНА +++
// Теперь возвращает полный массив значений RSI
export function rsi(closes, period=14){
  if(closes.length<period+1) return []; // Возвращаем пустой массив
  
  const rsiSeries = new Array(closes.length).fill(null);
  let gains=0, losses=0;

  // Первый расчет
  for(let i=1; i<=period; i++){ 
      const d=closes[i]-closes[i-1]; 
      if(d>=0) gains+=d; 
      else losses-=d; 
  }
  
  let avgG=gains/period;
  let avgL=losses/period;
  
  const rs = avgG / (avgL || MIN_DENOM);
  rsiSeries[period] = 100 - (100 / (1 + rs));

  // Последующие расчеты (сглаживание)
  for(let i=period+1; i<closes.length; i++){
    const d=closes[i]-closes[i-1];
    const g=d>0?d:0, l=d<0?-d:0;
    
    avgG=(avgG*(period-1)+g)/period; 
    avgL=(avgL*(period-1)+l)/period;
    
    const rs = avgG / (avgL || MIN_DENOM);
    rsiSeries[i] = 100 - (100 / (1 + rs));
  }
  
  return rsiSeries; // Возвращаем массив
}
// +++ КОНЕЦ ИСПРАВЛЕНИЯ RSI +++


export function macd(closes, fast=12, slow=26, signal=9){
  if(closes.length<slow+signal) return {macdLine:[], signalLine:[], hist: null};
  const kf=2/(fast+1), ks=2/(slow+1);
  let ef=sum(closes.slice(0,slow))/slow, es=ef;
  const macdSeries=[];
  for(let i=slow;i<closes.length;i++){
    ef=closes[i]*kf + ef*(1-kf);
    es=closes[i]*ks + es*(1-ks);
    macdSeries.push(ef-es);
  }
  
  const k=2/(signal+1);
  let prevSignal = sum(macdSeries.slice(0,signal))/signal;
  const signalLine = new Array(macdSeries.length).fill(null);
  
  for(let i=0; i<signal; i++){ signalLine[i] = macdSeries[i] - (macdSeries[i] - prevSignal); }

  for(let i=signal;i<macdSeries.length;i++){ 
      prevSignal = macdSeries[i]*k + prevSignal*(1-k); 
      signalLine[i] = prevSignal; 
  }
  
  const macdVal = macdSeries[macdSeries.length-1];
  const hist = macdVal - signalLine[macdSeries.length-1];

  return { macdLine: macdSeries, signalLine: signalLine, hist };
}