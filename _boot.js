const {spawn}=require('child_process');
const p=spawn('./node_modules/.bin/electron',['.'],{stdio:['ignore','inherit','inherit']});
setTimeout(()=>{try{p.kill('SIGKILL');}catch(e){}},8000);
p.on('exit',()=>process.exit(0));
