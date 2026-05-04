
rsync -avz --delete --exclude 'node_modules' --exclude '.next' --exclude '.git' --exclude '.env.local' ./ root@212.56.35.191:/app/

VfZ4j@9fhx!S5PqT2uWr

cd /app
npm ci
npm run build
pm2 restart next

pm2 logs next

npm run deploy:prod