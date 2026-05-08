const cron = require('node-cron');
const Status = require('../models/Status');
const { cloudinary } = require('../config/cloudinary');

// Native concurrency limiter to prevent Cloudinary 429 Rate Limit errors
const asyncPool = async (poolLimit, array, iteratorFn) => {
    const ret = [];
    const executing = [];
    for (const item of array) {
        const p = Promise.resolve().then(() => iteratorFn(item));
        ret.push(p);
        if (poolLimit <= array.length) {
            const e = p.then(() => executing.splice(executing.indexOf(e), 1));
            executing.push(e);
            if (executing.length >= poolLimit) {
                await Promise.race(executing);
            }
        }
    }
    return Promise.all(ret);
};

// Run every 15 minutes to scrub the database
cron.schedule('*/15 * * * *', async () => {
    try {
        const now = new Date();
        const cursor = Status.find({ expiresAt: { $lte: now } }).cursor();
        
        const batchSize = 50;
        let batch = [];

        // Process batch using controlled concurrency
        const processBatch = async (items) => {
            await asyncPool(5, items, async (status) => {
                try {
                    if (status.mediaPublicId) {
                        await cloudinary.uploader.destroy(status.mediaPublicId, {
                            resource_type: status.mediaType === 'video' ? 'video' : 'image'
                        });
                    }
                    await Status.findByIdAndDelete(status._id);
                } catch (err) {
                    console.error(`Failed to delete asset ${status.mediaPublicId}:`, err);
                }
            });
        };

        // Stream and chunk results
        for (let status = await cursor.next(); status != null; status = await cursor.next()) {
            batch.push(status);
            if (batch.length >= batchSize) {
                await processBatch(batch);
                batch = [];
            }
        }

        // Catch remainder
        if (batch.length > 0) {
            await processBatch(batch);
        }

    } catch (error) {
        console.error('Void Scrubber Critical Error:', error);
    }
});