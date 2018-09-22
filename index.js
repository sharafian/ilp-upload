const Koa = require('koa')
const port = process.env.PORT || 8088
const router = require('koa-router')()
const parser = require('koa-bodyparser')()
const serve = require('koa-static')
const path = require('path')
const app = new Koa()

const { Monetizer } = require('web-monetization-receiver')
const monetizer = new Monetizer()

if (!process.env.BUCKET) {
  throw new Error('bucket name must be specified as $BUCKET')
}

if (!process.env.PROJECT) {
  throw new Error('project name must be specified as $PROJECT')
}

const { Storage } = require('@google-cloud/storage')
const storage = new Storage({
  projectId: process.env.PROJECT
})

const bucket = storage.bucket(process.env.BUCKET)

router.get('/files/:name', async ctx => {
  if (/[^A-Za-z0-9\-_.]/.test(ctx.params.name)) {
    return ctx.throw(400, 'bad file name')
  }

  const file = bucket.file(ctx.params.name)
  console.log('got file metadata. metadata=', await file.getMetadata())

  const stream = file.createReadStream()
  ctx.body = ctx.webMonetization.monetizeStream(stream, {})
})

router.post('/files/:name', async ctx => {
  if (/[^A-Za-z0-9\-_.]/.test(ctx.params.name)) {
    return ctx.throw(400, 'bad file name')
  }
  
  const file = bucket.file(ctx.params.name)
  const stream = file.createWriteStream()
  ctx.webMonetization.monetizeStream(ctx.req, {}).pipe(stream)

  console.log('awaiting upload')
  await new Promise(resolve => {
    stream.on('finish', resolve)
  })

  console.log('finished upload')
  if (ctx.query.paymentPointer) {
    console.log('setting metadata')
    await file.setMetadata({
      contentType: 'application/octet-stream',      
      metadata: {
        paymentPointer: ctx.query.paymentPointer
      }
    })
  }

  console.log('returning response')
  ctx.body = {
    success: true,
    name: ctx.params.name
  }
})

app
  .use(monetizer.koa())
  .use(parser)
  .use(router.routes())
  .use(router.allowedMethods())
  .use(serve(path.resolve(__dirname, 'static')))
  .listen(port)

console.log('listening. port=' + port)
