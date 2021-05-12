import {
	flash,
	connect,
	Connection,
	flashCredentials,
	allSeen,
	log,
	runCmd,
	anySeen,
} from '@nordicsemiconductor/firmware-ci-device-helpers'
import { RunningFirmwareCIJobDocument } from '../job/job'

type Result = { timeout: boolean; abort: boolean }

export const runJob = async ({
	doc,
	hexfile,
	atHostHexfile,
	device,
	powerCycle,
	endOnWaitSeconds,
}: {
	doc: RunningFirmwareCIJobDocument
	hexfile: string
	atHostHexfile: string
	device: string
	powerCycle?: {
		offCmd: string
		onCmd: string
		waitSeconds: number
		waitSecondsAfterOn: number
	}
	endOnWaitSeconds?: number
}): Promise<{
	result: Result
	connection: Connection
	deviceLog: string[]
	flashLog: string[]
}> => {
	const { progress, warn } = log({ withTimestamp: true, prefixes: [doc.id] })

	if (powerCycle !== undefined) {
		progress(`Power cycling device`)
		progress(`Turning off ...`)
		progress(powerCycle.offCmd)
		await runCmd({ cmd: powerCycle.offCmd })
		progress(`Waiting ${powerCycle.waitSeconds} seconds ...`)
		await new Promise((resolve) =>
			setTimeout(resolve, powerCycle.waitSeconds * 1000),
		)
		progress(`Turning on ...`)
		progress(powerCycle.onCmd)
		await runCmd({ cmd: powerCycle.onCmd })

		progress(`Waiting ${powerCycle.waitSecondsAfterOn} seconds ...`)
		await new Promise((resolve) =>
			setTimeout(resolve, powerCycle.waitSecondsAfterOn * 1000),
		)
	}

	return new Promise((resolve, reject) => {
		let done = false
		progress(`Connecting to ${device}`)
		connect({
			device: device,
			atHostHexfile,
			...log(),
		})
			.then(async ({ connection, deviceLog, onData, onEnd }) => {
				let flashLog: string[] = []
				const { credentials } = doc

				progress(`Setting timeout to ${doc.timeoutInMinutes} minutes`)
				const jobTimeout = setTimeout(async () => {
					done = true
					warn('Timeout reached.')
					await connection.end()
					resolve({
						result: { timeout: true, abort: false },
						connection,
						deviceLog,
						flashLog,
					})
				}, doc.timeoutInMinutes * 60 * 1000)

				onEnd(async (_, timeout) => {
					if (timeout) {
						done = true
						clearTimeout(jobTimeout)
						warn(doc.id, 'Device read timeout occurred.')
						resolve({
							result: { timeout: true, abort: false },
							connection,
							deviceLog,
							flashLog,
						})
					}
					await flash({
						hexfile: atHostHexfile,
						...log({
							withTimestamp: true,
							prefixes: ['Resetting device with AT Host'],
						}),
					})
				})
				if (credentials !== undefined) {
					progress('Flashing credentials')
					await flashCredentials({
						...credentials,
						...connection,
					})
				}
				flashLog = await flash({
					hexfile,
					...log({
						withTimestamp: true,
						prefixes: ['Flash Firmware'],
					}),
				})

				const terminateOn = (
					type: 'abortOn' | 'endOn',
					result: Result,
					s: string[],
					t: (s: string[]) => (s: string) => boolean,
				) => {
					progress(
						`<${type}>`,
						`Setting up ${type} traps. Job will terminate if output contains:`,
					)
					s?.map((s) => progress(`<${type}>`, s))
					const terminateCheck = t(s)
					onData(async (data) => {
						s?.forEach(async (s) => {
							if (data.includes(s)) {
								warn(doc.id, `<${type}>`, 'Termination criteria seen:', s)
							}
						})
						if (terminateCheck(data)) {
							if (!done) {
								done = true
								warn(`<${type}>`, 'All termination criteria have been seen.')
								clearTimeout(jobTimeout)
								if (type === 'endOn')
									await new Promise((resolve) =>
										setTimeout(resolve, (endOnWaitSeconds ?? 60) * 1000),
									)
								await connection.end()
								resolve({
									result,
									connection,
									deviceLog,
									flashLog,
								})
							}
						}
					})
				}

				if (doc.abortOn !== undefined)
					terminateOn(
						'abortOn',
						{
							abort: true,
							timeout: false,
						},
						doc.abortOn,
						anySeen,
					)

				if (doc.endOn !== undefined)
					terminateOn(
						'endOn',
						{
							abort: false,
							timeout: false,
						},
						doc.endOn,
						allSeen,
					)
			})
			.catch(reject)
	})
}
