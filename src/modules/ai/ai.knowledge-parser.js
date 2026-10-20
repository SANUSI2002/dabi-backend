import { parentPort, workerData } from 'node:worker_threads';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { URL, fileURLToPath } from 'node:url';
try{
  const data=new Uint8Array(workerData.bytes);
  if(!data.length||data.length>10485760)throw new Error('PDF_TOO_LARGE');
  const task=getDocument({data,isEvalSupported:false,disableFontFace:true,useSystemFonts:false,stopAtErrors:true,maxImageSize:1,standardFontDataUrl:fileURLToPath(new URL('./standard_fonts/',import.meta.resolve('pdfjs-dist/package.json'))).replaceAll('\\','/')});
  const pdf=await task.promise;
  if(pdf.numPages<1||pdf.numPages>1000)throw new Error('PDF_PAGE_LIMIT');
  const labels=await pdf.getPageLabels();const pages=[];let total=0;
  for(let pageNumber=1;pageNumber<=pdf.numPages;pageNumber++){
    const page=await pdf.getPage(pageNumber);const content=await page.getTextContent();
    const text=content.items.map(i=>typeof i.str==='string'?i.str+(i.hasEOL?'\n':' '):'').join('').trim();
    total+=text.length;if(total>3000000||text.length>30000)throw new Error('PDF_TEXT_LIMIT');
    pages.push({pageNumber,pageLabel:labels?.[pageNumber-1]?.slice(0,40)||null,text});page.cleanup();
  }
  await task.destroy();parentPort.postMessage({pages});
}catch{parentPort.postMessage({error:'PDF_EXTRACTION_FAILED'});}
