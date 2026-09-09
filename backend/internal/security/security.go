package security

import (
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
	"golang.org/x/crypto/bcrypt"
)

var (
	ErrInvalidToken       = errors.New("invalid token")
	ErrTokenRevoked       = errors.New("token revoked")
	ErrNotAccessToken     = errors.New("not an access token")
	ErrNotRefreshToken    = errors.New("not a refresh token")
	ErrInvalidCredentials = errors.New("invalid credentials")
)

type SecurityManager struct {
	jwtSecret           []byte
	accessTokenDuration time.Duration
	refreshTokenDays    int
	passwordHash        string

	// Login Rate Limiter
	rateMu        sync.Mutex
	loginAttempts map[string][]time.Time
	maxIPs        int

	// In-memory revoked JTIs for access tokens
	jtiMu       sync.RWMutex
	revokedJTIs map[string]time.Time
}

func NewSecurityManager(jwtSecret string, accessMinutes, refreshDays int, passwordHash string) *SecurityManager {
	return &SecurityManager{
		jwtSecret:           []byte(jwtSecret),
		accessTokenDuration: time.Duration(accessMinutes) * time.Minute,
		refreshTokenDays:    refreshDays,
		passwordHash:        passwordHash,
		loginAttempts:       make(map[string][]time.Time),
		maxIPs:              10000,
		revokedJTIs:         make(map[string]time.Time),
	}
}

func (s *SecurityManager) SetPasswordHash(hash string) {
	s.passwordHash = hash
}

func (s *SecurityManager) GetPasswordHash() string {
	return s.passwordHash
}

func HashPassword(password string) (string, error) {
	bytes, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		return "", err
	}
	return string(bytes), nil
}

func (s *SecurityManager) VerifyPassword(password string) bool {
	if s.passwordHash == "" {
		return false
	}
	err := bcrypt.CompareHashAndPassword([]byte(s.passwordHash), []byte(password))
	return err == nil
}

func (s *SecurityManager) CheckLoginRate(ip string) bool {
	s.rateMu.Lock()
	defer s.rateMu.Unlock()

	now := time.Now().UTC()
	window := 60 * time.Second
	maxAttempts := 5

	// Clean expired for this IP
	attempts := s.loginAttempts[ip]
	validAttempts := attempts[:0]
	for _, t := range attempts {
		if now.Sub(t) <= window {
			validAttempts = append(validAttempts, t)
		}
	}

	if len(validAttempts) >= maxAttempts {
		s.loginAttempts[ip] = validAttempts
		return false
	}

	// Clean map if exceeding maxIPs
	if len(s.loginAttempts) >= s.maxIPs && len(validAttempts) == 0 {
		for k, v := range s.loginAttempts {
			if len(v) == 0 || now.Sub(v[len(v)-1]) > window {
				delete(s.loginAttempts, k)
			}
			if len(s.loginAttempts) < s.maxIPs {
				break
			}
		}
	}

	validAttempts = append(validAttempts, now)
	s.loginAttempts[ip] = validAttempts
	return true
}

func (s *SecurityManager) CreateAccessToken(deviceID uuid.UUID) (string, error) {
	now := time.Now().UTC()
	jti := uuid.New()
	claims := jwt.MapClaims{
		"sub":  deviceID.String(),
		"type": "access",
		"jti":  jti.String(),
		"iat":  now.Unix(),
		"exp":  now.Add(s.accessTokenDuration).Unix(),
	}

	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	return token.SignedString(s.jwtSecret)
}

func (s *SecurityManager) CreateRefreshToken(deviceID, jti uuid.UUID) (string, error) {
	now := time.Now().UTC()
	claims := jwt.MapClaims{
		"sub":  deviceID.String(),
		"type": "refresh",
		"jti":  jti.String(),
		"iat":  now.Unix(),
		"exp":  now.Add(time.Duration(s.refreshTokenDays) * 24 * time.Hour).Unix(),
	}

	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	return token.SignedString(s.jwtSecret)
}

func (s *SecurityManager) DecodeAccessToken(tokenStr string) (uuid.UUID, string, error) {
	token, err := jwt.Parse(tokenStr, func(token *jwt.Token) (interface{}, error) {
		if _, ok := token.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, fmt.Errorf("unexpected signing method: %v", token.Header["alg"])
		}
		return s.jwtSecret, nil
	})
	if err != nil || !token.Valid {
		return uuid.Nil, "", ErrInvalidToken
	}

	claims, ok := token.Claims.(jwt.MapClaims)
	if !ok {
		return uuid.Nil, "", ErrInvalidToken
	}

	tokenType, _ := claims["type"].(string)
	if tokenType != "access" {
		return uuid.Nil, "", ErrNotAccessToken
	}

	jti, _ := claims["jti"].(string)
	if jti == "" {
		return uuid.Nil, "", ErrInvalidToken
	}

	s.jtiMu.RLock()
	_, revoked := s.revokedJTIs[jti]
	s.jtiMu.RUnlock()
	if revoked {
		return uuid.Nil, "", ErrTokenRevoked
	}

	subStr, _ := claims["sub"].(string)
	deviceID, err := uuid.Parse(subStr)
	if err != nil {
		return uuid.Nil, "", ErrInvalidToken
	}

	return deviceID, jti, nil
}

func (s *SecurityManager) DecodeRefreshToken(tokenStr string) (uuid.UUID, uuid.UUID, error) {
	token, err := jwt.Parse(tokenStr, func(token *jwt.Token) (interface{}, error) {
		if _, ok := token.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, fmt.Errorf("unexpected signing method: %v", token.Header["alg"])
		}
		return s.jwtSecret, nil
	})
	if err != nil || !token.Valid {
		return uuid.Nil, uuid.Nil, ErrInvalidToken
	}

	claims, ok := token.Claims.(jwt.MapClaims)
	if !ok {
		return uuid.Nil, uuid.Nil, ErrInvalidToken
	}

	tokenType, _ := claims["type"].(string)
	if tokenType != "refresh" {
		return uuid.Nil, uuid.Nil, ErrNotRefreshToken
	}

	subStr, _ := claims["sub"].(string)
	deviceID, err := uuid.Parse(subStr)
	if err != nil {
		return uuid.Nil, uuid.Nil, ErrInvalidToken
	}

	jtiStr, _ := claims["jti"].(string)
	jti, err := uuid.Parse(jtiStr)
	if err != nil {
		return uuid.Nil, uuid.Nil, ErrInvalidToken
	}

	return deviceID, jti, nil
}

func (s *SecurityManager) RevokeAccessTokens(jtis ...string) {
	s.jtiMu.Lock()
	defer s.jtiMu.Unlock()
	now := time.Now().UTC()
	for _, jti := range jtis {
		if jti != "" {
			s.revokedJTIs[jti] = now
		}
	}
}

func (s *SecurityManager) CleanupRevokedJTIs(maxAge time.Duration) int {
	s.jtiMu.Lock()
	defer s.jtiMu.Unlock()

	now := time.Now().UTC()
	removed := 0
	for jti, revokedAt := range s.revokedJTIs {
		if now.Sub(revokedAt) > maxAge {
			delete(s.revokedJTIs, jti)
			removed++
		}
	}
	return removed
}

func (s *SecurityManager) ResetForTesting() {
	s.rateMu.Lock()
	s.loginAttempts = make(map[string][]time.Time)
	s.rateMu.Unlock()

	s.jtiMu.Lock()
	s.revokedJTIs = make(map[string]time.Time)
	s.jtiMu.Unlock()
}

