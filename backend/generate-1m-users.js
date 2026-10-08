// backend/generate-1m-users.js
const fs = require('node:fs');
const crypto = require('node:crypto');
const writeStream = fs.createWriteStream('backend/database.csv');

writeStream.write('id,email,password,status\n');
let i = 0;
const total = 1000000;

function write() {
    let ok = true;
    do {
        i++;
        const id = crypto.randomUUID();
        const email = `user${i}@test.com`;
        const pass = 'Password@123'; // Đủ điều kiện ràng buộc
        const status = 'valid';
        const row = `${id},${email},${pass},${status}\n`;

        if (i === total) {
            writeStream.write(row);
            writeStream.end()
            console.log('Tạo xong 1 triệu user!');
        } else {
            ok = writeStream.write(row);
        }
    } while (i < total && ok);
    if (i < total) writeStream.once('drain', write);
}
write();
