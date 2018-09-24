const Koa = require('koa')
const port = process.env.PORT || 8088
const router = require('koa-router')()
const parser = require('koa-bodyparser')()
const serve = require('koa-static')
const path = require('path')
const app = new Koa()

const makePlugin = require('ilp-plugin')
const SPSP = require('ilp-protocol-spsp')
const { Monetizer, Payer } = require('web-monetization-receiver')
const monetizer = new Monetizer()
const payer = new Payer()

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
  const [ metadata ] = await file.getMetadata()

  const paymentPointer = metadata.metadata && metadata.metadata.paymentPointer
  const stream = file.createReadStream()
  const paidStream = ctx.webMonetization.monetizeStream(stream, {})

  stream.on('error', e => {
    console.error('stream error', e)
  })

  ctx.body = paidStream
  ctx.set('Access-Control-Allow-Origin', '*')
})

router.post('/files/:name', async ctx => {
  if (/[^A-Za-z0-9\-_.]/.test(ctx.params.name)) {
    return ctx.throw(400, 'bad file name')
  }

  if (ctx.paymentPointer) {
    return ctx.throw(400, 'cannot upload if you\'re also monetizing to yourself')
  }

  const file = bucket.file(ctx.params.name)
  const stream = file.createWriteStream()
  ctx.webMonetization.monetizeStream(ctx.req, {}).pipe(stream)

  stream.on('error', e => {
    console.error('stream error', e)
  })

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

const base64url = buf => buf.toString('base64')
  .replace(/\+/g, '-')
  .replace(/\//g, '_')
  .replace(/=/g, '')

const spspReceiver = async (ctx, next) => {
  if (!ctx.cookies.get('webMonetization')) {
    ctx.cookies.set('webMonetization', base64url(crypto.randomBytes(16)))
  }

  const tag = ctx.cookies.get('webMonetization') +
    base64url(Buffer.from(ctx.query.pointer || ''))
  ctx.webMonetization = monetizer.getBucket(tag)
  ctx.paymentPointer = ctx.query.pointer

  if (ctx.get('accept').includes('application/spsp4+json')) {
    ctx.body = await monetizer.generateSPSPResponse(tag)
    ctx.set('Content-Type', 'application/spsp4+json')
    ctx.set('Access-Control-Allow-Origin', '*')
    return
  }

  return next()
}

async function run () {
  await monetizer.listen()
  monetizer.server.on('connection', conn => {
    const pointer = Buffer.from(
      // get payment pointer after random ID
      connection.connectionTag.substring(22), 'base64')
      .toString()

    conn.on('stream', stream => {
      stream.on('money', async amount => {
        try {
          await payer.pay(pointer, amount)
          console.log('paid out. pointer=' + pointer, 'amount=' + amount)
        } catch (e) {
          console.error('could not pay.' +
            ' pointer=' + pointer +
            ' error=' + e.stack)
        }
      })
    })
  })

  app
    .use(spspReceiver)
    .use(parser)
    .use(router.routes())
    .use(router.allowedMethods())
    .use(serve(path.resolve(__dirname, 'static')))
    .listen(port)

  console.log('listening. port=' + port)
}

run()
  .catch(e => {
    console.error(e)
    process.exit(1)
  })
