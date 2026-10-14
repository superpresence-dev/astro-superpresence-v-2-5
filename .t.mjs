import sharp from "sharp";
const [,,f,out,top,h,w]=process.argv;
const m=await sharp(f).metadata();
await sharp(f).extract({left:0,top:+top,width:m.width,height:Math.min(+h,m.height-+top)}).resize({width:+w}).toFile(out);
