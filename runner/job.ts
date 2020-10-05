export const defaultTimeoutInMinutes = 2

export type FirmwareCIJobDocument = {
	timeoutInMinutes?: number
	reportUrl: string
	fw: string
	target: string
	credentials?: {
		secTag: number
		privateKey: string
		clientCert: string
		caCert: string
	}
}

export type RunningFirmwareCIJobDocument = {
	id: string
	timeoutInMinutes: number
} & FirmwareCIJobDocument
